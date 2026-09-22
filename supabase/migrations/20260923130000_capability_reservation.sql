-- Capability reservation, balance locking, expiry, and consumption/release.
-- Parallel requests reserve and consume only available policy capacity.
-- These tables and functions contain no commercial billing, pricing, or subscription concepts.

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
  reserved_quantity numeric not null default 0,
  consumed_quantity numeric not null default 0,
  released_quantity numeric not null default 0,
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
    reserved_quantity >= 0 and reserved_quantity <= 9007199254740991
    and consumed_quantity >= 0 and consumed_quantity <= 9007199254740991
    and released_quantity >= 0 and released_quantity <= 9007199254740991
    and reserved_quantity = (reserved_quantity::float8)::numeric
    and consumed_quantity = (consumed_quantity::float8)::numeric
    and released_quantity = (released_quantity::float8)::numeric
  ),
  constraint capability_reservation_balances_updated_at_valid check (
    updated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision),
  unique (
    tenant_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key, unit, policy_id, policy_revision
  )
);

create table vortex_access.capability_reservations (
  reservation_id uuid not null primary key,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  organization_id uuid references vortex_identity.organizations (organization_id),
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
  duplicate_key uuid not null unique,
  command_fingerprint text not null,
  correlation_id uuid not null,
  constraint capability_reservations_ids_non_nil check (
    vortex_context.is_non_nil_uuid(reservation_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and vortex_context.is_non_nil_uuid(policy_id::text)
    and vortex_context.is_non_nil_uuid(assignment_id::text)
    and vortex_context.is_non_nil_uuid(duplicate_key::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint capability_reservations_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
  ),
  constraint capability_reservations_revisions_valid check (
    policy_revision between 1 and 9007199254740991
    and assignment_revision between 1 and 9007199254740991
  ),
  constraint capability_reservations_quantities_valid check (
    vortex_access.capability_policy_quantity_is_valid(policy_quantity_limit)
    and vortex_access.capability_policy_quantity_is_valid(reserved_quantity)
    and consumed_quantity >= 0 and consumed_quantity <= 9007199254740991
    and released_quantity >= 0 and released_quantity <= 9007199254740991
    and consumed_quantity = (consumed_quantity::float8)::numeric
    and released_quantity = (released_quantity::float8)::numeric
    and (consumed_quantity + released_quantity) <= reserved_quantity
  ),
  constraint capability_reservations_times_valid check (
    created_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and updated_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and expires_at > created_at
    and (consumed_at is null or consumed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (released_at is null or released_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expired_at is null or expired_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
  ),
  constraint capability_reservations_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision)
);

create table vortex_access.capability_reservation_operations (
  operation_id uuid not null primary key,
  reservation_id uuid not null references vortex_access.capability_reservations (reservation_id),
  operation_kind text not null check (operation_kind in ('consume', 'release')),
  quantity numeric not null,
  duplicate_key uuid not null unique,
  command_fingerprint text not null,
  correlation_id uuid not null,
  accepted_at timestamptz not null,
  constraint capability_reservation_operations_ids_non_nil check (
    vortex_context.is_non_nil_uuid(operation_id::text)
    and vortex_context.is_non_nil_uuid(reservation_id::text)
    and vortex_context.is_non_nil_uuid(duplicate_key::text)
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint capability_reservation_operations_quantity_valid check (
    vortex_access.capability_policy_quantity_is_valid(quantity)
  ),
  constraint capability_reservation_operations_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint capability_reservation_operations_accepted_at_valid check (
    accepted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

create index capability_reservation_balances_assignment_idx
  on vortex_access.capability_reservation_balances (assignment_id);

create index capability_reservations_assignment_state_expires_idx
  on vortex_access.capability_reservations (assignment_id, state, expires_at);

create index capability_reservations_scope_state_idx
  on vortex_access.capability_reservations (
    tenant_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key, unit, state
  );

create index capability_reservation_operations_reservation_idx
  on vortex_access.capability_reservation_operations (reservation_id, operation_kind);

alter table vortex_access.capability_reservation_balances enable row level security;
alter table vortex_access.capability_reservation_balances force row level security;
alter table vortex_access.capability_reservations enable row level security;
alter table vortex_access.capability_reservations force row level security;
alter table vortex_access.capability_reservation_operations enable row level security;
alter table vortex_access.capability_reservation_operations force row level security;

revoke all on table vortex_access.capability_reservation_balances,
  vortex_access.capability_reservations,
  vortex_access.capability_reservation_operations
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create function vortex_access.expire_stale_capability_reservations(
  p_tenant_id uuid,
  p_assignment_id uuid default null
)
returns table (
  expired_count integer,
  evaluated_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  clock_now timestamptz := pg_catalog.clock_timestamp();
  affected_count integer;
  affected_assignment record;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_assignment_id is not null and not vortex_context.is_non_nil_uuid(p_assignment_id::text)) then
    raise exception using errcode = '22023', message = 'Expire stale reservations parameters invalid';
  end if;

  with expired_rows as (
    update vortex_access.capability_reservations
    set state = 'expired',
        expired_at = clock_now,
        updated_at = clock_now
    where tenant_id = p_tenant_id
      and (p_assignment_id is null or assignment_id = p_assignment_id)
      and state = 'active'
      and expires_at <= clock_now
    returning assignment_id, policy_id, policy_revision, organization_id, capability_key, unit
  )
  select count(*)::integer into affected_count from expired_rows;

  -- Recompute balance for any assignment that had expired reservations
  for affected_assignment in
    select distinct assignment_id, policy_id, policy_revision, organization_id, capability_key, unit
    from vortex_access.capability_reservations
    where tenant_id = p_tenant_id
      and (p_assignment_id is null or assignment_id = p_assignment_id)
      and state = 'expired'
      and expired_at = clock_now
  loop
    update vortex_access.capability_reservation_balances
    set reserved_quantity = (
      select coalesce(sum(reserved_quantity - consumed_quantity - released_quantity), 0)
      from vortex_access.capability_reservations
      where assignment_id = affected_assignment.assignment_id
        and policy_id = affected_assignment.policy_id
        and policy_revision = affected_assignment.policy_revision
        and state = 'active'
    ),
    updated_at = clock_now
    where tenant_id = p_tenant_id
      and organization_id is not distinct from affected_assignment.organization_id
      and capability_key = affected_assignment.capability_key
      and unit = affected_assignment.unit
      and policy_id = affected_assignment.policy_id
      and policy_revision = affected_assignment.policy_revision;
  end loop;

  return query select coalesce(affected_count, 0), clock_now;
end
$function$;

create function vortex_access.reserve_capability_quantity(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_assignment_id uuid,
  p_assignment_revision bigint,
  p_policy_quantity_limit numeric,
  p_requested_quantity numeric,
  p_duplicate_key uuid,
  p_expires_at timestamptz default null,
  p_reservation_id uuid default null,
  p_correlation_id uuid default null
)
returns table (
  outcome text,
  status text,
  reservation_id uuid,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  applied_scope text,
  policy_quantity_limit numeric,
  active_reserved_quantity numeric,
  consumed_quantity numeric,
  released_quantity numeric,
  available_quantity numeric,
  reserved_quantity numeric,
  created_at timestamptz,
  expires_at timestamptz,
  correlation_id uuid,
  reason_code text
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  command_fingerprint text;
  existing_reservation vortex_access.capability_reservations%rowtype;
  current_assignment vortex_access.capability_policy_assignments%rowtype;
  current_definition vortex_access.capability_policy_definitions%rowtype;
  current_active_reserved numeric;
  current_consumed numeric;
  current_released numeric;
  available_quantity numeric;
  current_applied_scope text;
  resulting_reservation_id uuid := coalesce(p_reservation_id, pg_catalog.gen_random_uuid());
  resulting_correlation uuid := coalesce(p_correlation_id, pg_catalog.gen_random_uuid());
  resulting_expires_at timestamptz;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision is null or p_assignment_revision not between 1 and 9007199254740991
    or not vortex_access.capability_policy_quantity_is_valid(p_policy_quantity_limit)
    or not vortex_access.capability_policy_quantity_is_valid(p_requested_quantity)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or (p_reservation_id is not null and not vortex_context.is_non_nil_uuid(p_reservation_id::text))
    or (p_correlation_id is not null and not vortex_context.is_non_nil_uuid(p_correlation_id::text))
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)) then
    raise exception using errcode = '22023', message = 'Capability reservation command is invalid';
  end if;

  context_organization_id := (context ->> 'organizationId')::uuid;
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null and context_organization_id is distinct from p_organization_id)
    or (context_organization_id is not null and p_organization_id is null) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'reserve_capability_quantity',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_capability_key, p_unit,
      p_policy_id::text, p_policy_revision::text, p_assignment_id::text, p_assignment_revision::text,
      p_requested_quantity::text), 'UTF8'), 'sha256'), 'hex');

  -- Replay check for duplicate key
  select stored.* into existing_reservation
  from vortex_access.capability_reservations as stored
  where stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_reservation.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability reservation duplicate conflicts';
    end if;

    select
      coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
      coalesce(sum(consumed_quantity), 0),
      coalesce(sum(released_quantity), 0)
    into current_active_reserved, current_consumed, current_released
    from vortex_access.capability_reservations
    where assignment_id = existing_reservation.assignment_id
      and policy_id = existing_reservation.policy_id
      and policy_revision = existing_reservation.policy_revision;

    available_quantity := greatest(0::numeric, existing_reservation.policy_quantity_limit - (current_active_reserved + current_consumed));

    return query select
      'reserved'::text, 'replayed'::text, existing_reservation.reservation_id,
      existing_reservation.tenant_id, existing_reservation.organization_id,
      existing_reservation.capability_key, existing_reservation.unit,
      existing_reservation.policy_id, existing_reservation.policy_revision,
      existing_reservation.assignment_id, existing_reservation.assignment_revision,
      existing_reservation.applied_scope, existing_reservation.policy_quantity_limit,
      current_active_reserved, current_consumed, current_released, available_quantity,
      existing_reservation.reserved_quantity, existing_reservation.created_at,
      existing_reservation.expires_at, existing_reservation.correlation_id, null::text;
    return;
  end if;

  if exists (
    select 1 from vortex_access.capability_reservation_operations
    where duplicate_key = p_duplicate_key
  ) then
    raise exception using errcode = 'V3001', message = 'Capability reservation duplicate conflicts';
  end if;

  -- Lock the exact effective assignment
  select assignment.* into current_assignment
  from vortex_access.capability_policy_assignments assignment
  where assignment.assignment_id = p_assignment_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy assignment is unavailable';
  end if;

  if current_assignment.tenant_id <> p_tenant_id
    or current_assignment.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Capability policy assignment scope is unavailable';
  end if;

  if current_assignment.capability_key <> p_capability_key
    or current_assignment.unit <> p_unit then
    raise exception using errcode = '22023', message = 'Capability policy assignment scope mismatch';
  end if;

  if current_assignment.policy_id <> p_policy_id
    or current_assignment.policy_revision <> p_policy_revision then
    raise exception using errcode = 'V3102', message = 'Capability policy definition revision is stale';
  end if;

  if current_assignment.revision <> p_assignment_revision then
    raise exception using errcode = 'V3102', message = 'Capability policy assignment is stale';
  end if;

  if current_assignment.revoked_at is not null then
    raise exception using errcode = 'V3102', message = 'Capability policy assignment is revoked';
  end if;

  if current_assignment.starts_at > evaluated_at
    or (current_assignment.expires_at is not null and current_assignment.expires_at <= evaluated_at) then
    raise exception using errcode = 'V3102', message = 'Capability policy assignment is expired';
  end if;

  -- Verify definition
  select definition.* into current_definition
  from vortex_access.capability_policy_definitions definition
  where definition.tenant_id = p_tenant_id
    and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy definition revision is unavailable';
  end if;

  if current_definition.quantity_limit <> p_policy_quantity_limit then
    raise exception using errcode = 'V3102', message = 'Capability policy definition limit is stale';
  end if;

  -- Expire stale reservations in the same transaction
  update vortex_access.capability_reservations
  set state = 'expired',
      expired_at = evaluated_at,
      updated_at = evaluated_at
  where assignment_id = p_assignment_id
    and state = 'active'
    and expires_at <= evaluated_at;

  -- Calculate current balances under the assignment lock
  select
    coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
    coalesce(sum(consumed_quantity), 0),
    coalesce(sum(released_quantity), 0)
  into current_active_reserved, current_consumed, current_released
  from vortex_access.capability_reservations
  where assignment_id = p_assignment_id
    and policy_id = p_policy_id
    and policy_revision = p_policy_revision;

  available_quantity := current_definition.quantity_limit - (current_active_reserved + current_consumed);
  current_applied_scope := case when current_assignment.organization_id is not null then 'organization' else 'tenant' end;

  if available_quantity < p_requested_quantity then
    return query select
      'refused'::text, 'accepted'::text, null::uuid,
      p_tenant_id, p_organization_id, p_capability_key, p_unit,
      p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision,
      current_applied_scope, current_definition.quantity_limit,
      current_active_reserved, current_consumed, current_released,
      greatest(0::numeric, available_quantity),
      null::numeric, evaluated_at, null::timestamptz,
      resulting_correlation, 'insufficient_capacity'::text;
    return;
  end if;

  resulting_expires_at := coalesce(p_expires_at, evaluated_at + interval '300 seconds');
  if resulting_expires_at <= evaluated_at then
    raise exception using errcode = '22023', message = 'Capability reservation expiry must be in the future';
  end if;

  insert into vortex_access.capability_reservations (
    reservation_id, tenant_id, organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    applied_scope, policy_quantity_limit, reserved_quantity,
    consumed_quantity, released_quantity, state,
    created_at, expires_at, updated_at,
    duplicate_key, command_fingerprint, correlation_id
  ) values (
    resulting_reservation_id, p_tenant_id, p_organization_id, p_capability_key, p_unit,
    p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision,
    current_applied_scope, current_definition.quantity_limit, p_requested_quantity,
    0, 0, 'active',
    evaluated_at, resulting_expires_at, evaluated_at,
    p_duplicate_key, command_fingerprint, resulting_correlation
  );

  insert into vortex_access.capability_reservation_balances (
    balance_id, tenant_id, organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    reserved_quantity, consumed_quantity, released_quantity, updated_at
  ) values (
    pg_catalog.gen_random_uuid(), p_tenant_id, p_organization_id, p_capability_key, p_unit,
    p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision,
    current_active_reserved + p_requested_quantity, current_consumed, current_released, evaluated_at
  )
  on conflict (
    tenant_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key, unit, policy_id, policy_revision
  ) do update set
    assignment_id = p_assignment_id,
    assignment_revision = p_assignment_revision,
    reserved_quantity = current_active_reserved + p_requested_quantity,
    consumed_quantity = current_consumed,
    released_quantity = current_released,
    updated_at = evaluated_at;

  return query select
    'reserved'::text, 'accepted'::text, resulting_reservation_id,
    p_tenant_id, p_organization_id, p_capability_key, p_unit,
    p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision,
    current_applied_scope, current_definition.quantity_limit,
    (current_active_reserved + p_requested_quantity),
    current_consumed, current_released,
    (available_quantity - p_requested_quantity),
    p_requested_quantity, evaluated_at, resulting_expires_at,
    resulting_correlation, null::text;
end
$function$;

create function vortex_access.consume_capability_reservation(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_assignment_id uuid,
  p_reservation_id uuid,
  p_quantity numeric,
  p_duplicate_key uuid,
  p_correlation_id uuid default null
)
returns table (
  outcome text,
  status text,
  reservation_id uuid,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  applied_scope text,
  policy_quantity_limit numeric,
  active_reserved_quantity numeric,
  consumed_quantity numeric,
  released_quantity numeric,
  available_quantity numeric,
  consumed_amount numeric,
  reservation_consumed_quantity numeric,
  reservation_remaining_quantity numeric,
  reservation_state text,
  consumed_at timestamptz,
  correlation_id uuid
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  command_fingerprint text;
  existing_operation vortex_access.capability_reservation_operations%rowtype;
  target_reservation vortex_access.capability_reservations%rowtype;
  remaining_reserved numeric;
  new_consumed numeric;
  new_remaining numeric;
  new_state text;
  current_active_reserved numeric;
  current_consumed numeric;
  current_released numeric;
  available_quantity numeric;
  resulting_correlation uuid := coalesce(p_correlation_id, pg_catalog.gen_random_uuid());
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_reservation_id is null or not vortex_context.is_non_nil_uuid(p_reservation_id::text)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or (p_correlation_id is not null and not vortex_context.is_non_nil_uuid(p_correlation_id::text)) then
    raise exception using errcode = '22023', message = 'Capability consumption command is invalid';
  end if;

  context_organization_id := (context ->> 'organizationId')::uuid;
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null and context_organization_id is distinct from p_organization_id)
    or (context_organization_id is not null and p_organization_id is null) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'consume_capability_reservation',
      p_reservation_id::text, p_tenant_id::text, coalesce(p_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_quantity::text), 'UTF8'), 'sha256'), 'hex');

  select stored.* into existing_operation
  from vortex_access.capability_reservation_operations as stored
  where stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_operation.command_fingerprint <> command_fingerprint
      or existing_operation.reservation_id <> p_reservation_id
      or existing_operation.operation_kind <> 'consume' then
      raise exception using errcode = 'V3001', message = 'Capability consumption duplicate conflicts';
    end if;

    select * into target_reservation
    from vortex_access.capability_reservations
    where reservation_id = p_reservation_id;

    select
      coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
      coalesce(sum(consumed_quantity), 0),
      coalesce(sum(released_quantity), 0)
    into current_active_reserved, current_consumed, current_released
    from vortex_access.capability_reservations
    where assignment_id = target_reservation.assignment_id
      and policy_id = target_reservation.policy_id
      and policy_revision = target_reservation.policy_revision;

    available_quantity := greatest(0::numeric, target_reservation.policy_quantity_limit - (current_active_reserved + current_consumed));
    remaining_reserved := target_reservation.reserved_quantity - target_reservation.consumed_quantity - target_reservation.released_quantity;

    return query select
      'consumed'::text, 'replayed'::text, p_reservation_id,
      target_reservation.tenant_id, target_reservation.organization_id,
      target_reservation.capability_key, target_reservation.unit,
      target_reservation.policy_id, target_reservation.policy_revision,
      target_reservation.assignment_id, target_reservation.assignment_revision,
      target_reservation.applied_scope, target_reservation.policy_quantity_limit,
      current_active_reserved, current_consumed, current_released, available_quantity,
      existing_operation.quantity, target_reservation.consumed_quantity,
      remaining_reserved, target_reservation.state,
      existing_operation.accepted_at, existing_operation.correlation_id;
    return;
  end if;

  if exists (
    select 1 from vortex_access.capability_reservations
    where duplicate_key = p_duplicate_key
  ) then
    raise exception using errcode = 'V3001', message = 'Capability consumption duplicate conflicts';
  end if;

  select * into target_reservation
  from vortex_access.capability_reservations
  where reservation_id = p_reservation_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability reservation is unavailable';
  end if;

  if target_reservation.tenant_id <> p_tenant_id
    or target_reservation.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;

  if target_reservation.capability_key <> p_capability_key
    or target_reservation.unit <> p_unit then
    raise exception using errcode = '22023', message = 'Capability reservation scope mismatch';
  end if;

  if target_reservation.policy_id <> p_policy_id
    or target_reservation.policy_revision <> p_policy_revision then
    raise exception using errcode = 'V3102', message = 'Capability reservation policy revision mismatch';
  end if;

  if target_reservation.assignment_id <> p_assignment_id then
    raise exception using errcode = 'V3102', message = 'Capability reservation assignment mismatch';
  end if;

  if target_reservation.state = 'expired' or target_reservation.expires_at <= evaluated_at then
    if target_reservation.state <> 'expired' then
      update vortex_access.capability_reservations
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation_id = p_reservation_id;
    end if;
    raise exception using errcode = 'V3102', message = 'Capability reservation is expired';
  end if;

  if target_reservation.state = 'released' then
    raise exception using errcode = 'V3102', message = 'Capability reservation is already released';
  end if;

  remaining_reserved := target_reservation.reserved_quantity - target_reservation.consumed_quantity - target_reservation.released_quantity;
  if p_quantity > remaining_reserved then
    raise exception using errcode = '22023', message = 'Consumption quantity exceeds reserved quantity';
  end if;

  perform 1 from vortex_access.capability_policy_assignments
  where assignment_id = target_reservation.assignment_id for update;

  new_consumed := target_reservation.consumed_quantity + p_quantity;
  new_remaining := remaining_reserved - p_quantity;
  new_state := case when (new_consumed + target_reservation.released_quantity) >= target_reservation.reserved_quantity then 'consumed' else 'active' end;

  update vortex_access.capability_reservations
  set consumed_quantity = new_consumed,
      state = new_state,
      consumed_at = evaluated_at,
      updated_at = evaluated_at
  where reservation_id = p_reservation_id;

  insert into vortex_access.capability_reservation_operations (
    operation_id, reservation_id, operation_kind, quantity,
    duplicate_key, command_fingerprint, correlation_id, accepted_at
  ) values (
    pg_catalog.gen_random_uuid(), p_reservation_id, 'consume', p_quantity,
    p_duplicate_key, command_fingerprint, resulting_correlation, evaluated_at
  );

  select
    coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
    coalesce(sum(consumed_quantity), 0),
    coalesce(sum(released_quantity), 0)
  into current_active_reserved, current_consumed, current_released
  from vortex_access.capability_reservations
  where assignment_id = target_reservation.assignment_id
    and policy_id = target_reservation.policy_id
    and policy_revision = target_reservation.policy_revision;

  available_quantity := greatest(0::numeric, target_reservation.policy_quantity_limit - (current_active_reserved + current_consumed));

  update vortex_access.capability_reservation_balances
  set reserved_quantity = current_active_reserved,
      consumed_quantity = current_consumed,
      released_quantity = current_released,
      updated_at = evaluated_at
  where tenant_id = target_reservation.tenant_id
    and organization_id is not distinct from target_reservation.organization_id
    and capability_key = target_reservation.capability_key
    and unit = target_reservation.unit
    and policy_id = target_reservation.policy_id
    and policy_revision = target_reservation.policy_revision;

  return query select
    'consumed'::text, 'accepted'::text, p_reservation_id,
    target_reservation.tenant_id, target_reservation.organization_id,
    target_reservation.capability_key, target_reservation.unit,
    target_reservation.policy_id, target_reservation.policy_revision,
    target_reservation.assignment_id, target_reservation.assignment_revision,
    target_reservation.applied_scope, target_reservation.policy_quantity_limit,
    current_active_reserved, current_consumed, current_released, available_quantity,
    p_quantity, new_consumed, new_remaining, new_state,
    evaluated_at, resulting_correlation;
end
$function$;

create function vortex_access.release_capability_reservation(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_assignment_id uuid,
  p_reservation_id uuid,
  p_duplicate_key uuid,
  p_quantity numeric default null,
  p_correlation_id uuid default null
)
returns table (
  outcome text,
  status text,
  reservation_id uuid,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  applied_scope text,
  policy_quantity_limit numeric,
  active_reserved_quantity numeric,
  consumed_quantity numeric,
  released_quantity numeric,
  available_quantity numeric,
  released_amount numeric,
  reservation_released_quantity numeric,
  reservation_remaining_quantity numeric,
  reservation_state text,
  released_at timestamptz,
  correlation_id uuid
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  command_fingerprint text;
  existing_operation vortex_access.capability_reservation_operations%rowtype;
  target_reservation vortex_access.capability_reservations%rowtype;
  remaining_reserved numeric;
  release_amount numeric;
  new_released numeric;
  new_remaining numeric;
  new_state text;
  current_active_reserved numeric;
  current_consumed numeric;
  current_released numeric;
  available_quantity numeric;
  resulting_correlation uuid := coalesce(p_correlation_id, pg_catalog.gen_random_uuid());
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_reservation_id is null or not vortex_context.is_non_nil_uuid(p_reservation_id::text)
    or (p_quantity is not null and not vortex_access.capability_policy_quantity_is_valid(p_quantity))
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or (p_correlation_id is not null and not vortex_context.is_non_nil_uuid(p_correlation_id::text)) then
    raise exception using errcode = '22023', message = 'Capability release command is invalid';
  end if;

  context_organization_id := (context ->> 'organizationId')::uuid;
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null and context_organization_id is distinct from p_organization_id)
    or (context_organization_id is not null and p_organization_id is null) then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'release_capability_reservation',
      p_reservation_id::text, p_tenant_id::text, coalesce(p_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, coalesce(p_quantity::text, 'all')), 'UTF8'), 'sha256'), 'hex');

  select stored.* into existing_operation
  from vortex_access.capability_reservation_operations as stored
  where stored.duplicate_key = p_duplicate_key for update;
  if found then
    if existing_operation.command_fingerprint <> command_fingerprint
      or existing_operation.reservation_id <> p_reservation_id
      or existing_operation.operation_kind <> 'release' then
      raise exception using errcode = 'V3001', message = 'Capability release duplicate conflicts';
    end if;

    select * into target_reservation
    from vortex_access.capability_reservations
    where reservation_id = p_reservation_id;

    select
      coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
      coalesce(sum(consumed_quantity), 0),
      coalesce(sum(released_quantity), 0)
    into current_active_reserved, current_consumed, current_released
    from vortex_access.capability_reservations
    where assignment_id = target_reservation.assignment_id
      and policy_id = target_reservation.policy_id
      and policy_revision = target_reservation.policy_revision;

    available_quantity := greatest(0::numeric, target_reservation.policy_quantity_limit - (current_active_reserved + current_consumed));
    remaining_reserved := target_reservation.reserved_quantity - target_reservation.consumed_quantity - target_reservation.released_quantity;

    return query select
      'released'::text, 'replayed'::text, p_reservation_id,
      target_reservation.tenant_id, target_reservation.organization_id,
      target_reservation.capability_key, target_reservation.unit,
      target_reservation.policy_id, target_reservation.policy_revision,
      target_reservation.assignment_id, target_reservation.assignment_revision,
      target_reservation.applied_scope, target_reservation.policy_quantity_limit,
      current_active_reserved, current_consumed, current_released, available_quantity,
      existing_operation.quantity, target_reservation.released_quantity,
      remaining_reserved, target_reservation.state,
      existing_operation.accepted_at, existing_operation.correlation_id;
    return;
  end if;

  if exists (
    select 1 from vortex_access.capability_reservations
    where duplicate_key = p_duplicate_key
  ) then
    raise exception using errcode = 'V3001', message = 'Capability release duplicate conflicts';
  end if;

  select * into target_reservation
  from vortex_access.capability_reservations
  where reservation_id = p_reservation_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability reservation is unavailable';
  end if;

  if target_reservation.tenant_id <> p_tenant_id
    or target_reservation.organization_id is distinct from p_organization_id then
    raise exception using errcode = '42501', message = 'Capability reservation scope is unavailable';
  end if;

  if target_reservation.capability_key <> p_capability_key
    or target_reservation.unit <> p_unit then
    raise exception using errcode = '22023', message = 'Capability reservation scope mismatch';
  end if;

  if target_reservation.policy_id <> p_policy_id
    or target_reservation.policy_revision <> p_policy_revision then
    raise exception using errcode = 'V3102', message = 'Capability reservation policy revision mismatch';
  end if;

  if target_reservation.assignment_id <> p_assignment_id then
    raise exception using errcode = 'V3102', message = 'Capability reservation assignment mismatch';
  end if;

  if target_reservation.state = 'released' then
    raise exception using errcode = 'V3102', message = 'Capability reservation is already released';
  end if;

  if target_reservation.state = 'expired' or target_reservation.expires_at <= evaluated_at then
    if target_reservation.state <> 'expired' then
      update vortex_access.capability_reservations
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation_id = p_reservation_id;
    end if;
    raise exception using errcode = 'V3102', message = 'Capability reservation is expired';
  end if;

  remaining_reserved := target_reservation.reserved_quantity - target_reservation.consumed_quantity - target_reservation.released_quantity;
  release_amount := coalesce(p_quantity, remaining_reserved);
  if release_amount <= 0 or release_amount > remaining_reserved then
    raise exception using errcode = '22023', message = 'Release quantity exceeds reserved quantity';
  end if;

  perform 1 from vortex_access.capability_policy_assignments
  where assignment_id = target_reservation.assignment_id for update;

  new_released := target_reservation.released_quantity + release_amount;
  new_remaining := remaining_reserved - release_amount;
  new_state := case when (target_reservation.consumed_quantity + new_released) >= target_reservation.reserved_quantity then 'released' else target_reservation.state end;

  update vortex_access.capability_reservations
  set released_quantity = new_released,
      state = new_state,
      released_at = evaluated_at,
      updated_at = evaluated_at
  where reservation_id = p_reservation_id;

  insert into vortex_access.capability_reservation_operations (
    operation_id, reservation_id, operation_kind, quantity,
    duplicate_key, command_fingerprint, correlation_id, accepted_at
  ) values (
    pg_catalog.gen_random_uuid(), p_reservation_id, 'release', release_amount,
    p_duplicate_key, command_fingerprint, resulting_correlation, evaluated_at
  );

  select
    coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
    coalesce(sum(consumed_quantity), 0),
    coalesce(sum(released_quantity), 0)
  into current_active_reserved, current_consumed, current_released
  from vortex_access.capability_reservations
  where assignment_id = target_reservation.assignment_id
    and policy_id = target_reservation.policy_id
    and policy_revision = target_reservation.policy_revision;

  available_quantity := greatest(0::numeric, target_reservation.policy_quantity_limit - (current_active_reserved + current_consumed));

  update vortex_access.capability_reservation_balances
  set reserved_quantity = current_active_reserved,
      consumed_quantity = current_consumed,
      released_quantity = current_released,
      updated_at = evaluated_at
  where tenant_id = target_reservation.tenant_id
    and organization_id is not distinct from target_reservation.organization_id
    and capability_key = target_reservation.capability_key
    and unit = target_reservation.unit
    and policy_id = target_reservation.policy_id
    and policy_revision = target_reservation.policy_revision;

  return query select
    'released'::text, 'accepted'::text, p_reservation_id,
    target_reservation.tenant_id, target_reservation.organization_id,
    target_reservation.capability_key, target_reservation.unit,
    target_reservation.policy_id, target_reservation.policy_revision,
    target_reservation.assignment_id, target_reservation.assignment_revision,
    target_reservation.applied_scope, target_reservation.policy_quantity_limit,
    current_active_reserved, current_consumed, current_released, available_quantity,
    release_amount, new_released, new_remaining, new_state,
    evaluated_at, resulting_correlation;
end
$function$;

create function vortex_access.read_capability_reservation_balance(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  applied_scope text,
  policy_quantity_limit numeric,
  active_reserved_quantity numeric,
  consumed_quantity numeric,
  released_quantity numeric,
  available_quantity numeric,
  evaluated_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  clock_now timestamptz := pg_catalog.clock_timestamp();
  effective record;
  current_active_reserved numeric;
  current_consumed numeric;
  current_released numeric;
  available_quantity numeric;
begin
  select * into effective
  from vortex_access.resolve_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit
  );

  if effective.outcome is distinct from 'available' then
    raise exception using errcode = 'V3101', message = 'Capability policy is not assigned';
  end if;

  -- Expire stale reservations for this assignment
  update vortex_access.capability_reservations
  set state = 'expired',
      expired_at = clock_now,
      updated_at = clock_now
  where assignment_id = effective.assignment_id
    and state = 'active'
    and expires_at <= clock_now;

  select
    coalesce(sum(case when state = 'active' then (reserved_quantity - consumed_quantity - released_quantity) else 0 end), 0),
    coalesce(sum(consumed_quantity), 0),
    coalesce(sum(released_quantity), 0)
  into current_active_reserved, current_consumed, current_released
  from vortex_access.capability_reservations
  where assignment_id = effective.assignment_id
    and policy_id = effective.policy_id
    and policy_revision = effective.policy_revision;

  available_quantity := greatest(0::numeric, effective.quantity_limit - (current_active_reserved + current_consumed));

  return query select
    p_tenant_id, effective.organization_id, p_capability_key, p_unit,
    effective.policy_id, effective.policy_revision,
    effective.assignment_id, effective.assignment_revision,
    effective.applied_scope, effective.quantity_limit,
    current_active_reserved, current_consumed, current_released,
    available_quantity, clock_now;
end
$function$;

revoke execute on function
  vortex_access.expire_stale_capability_reservations(uuid, uuid),
  vortex_access.reserve_capability_quantity(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, numeric, numeric, uuid, timestamptz, uuid, uuid
  ),
  vortex_access.consume_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, uuid, numeric, uuid, uuid
  ),
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, uuid, uuid, numeric, uuid
  ),
  vortex_access.read_capability_reservation_balance(uuid, uuid, text, text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function
  vortex_access.expire_stale_capability_reservations(uuid, uuid),
  vortex_access.reserve_capability_quantity(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, numeric, numeric, uuid, timestamptz, uuid, uuid
  ),
  vortex_access.consume_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, uuid, numeric, uuid, uuid
  ),
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, uuid, uuid, numeric, uuid
  ),
  vortex_access.read_capability_reservation_balance(uuid, uuid, text, text)
to vortex_request;

comment on table vortex_access.capability_reservation_balances is
  'Locked aggregate balances per effective capability policy revision.';
comment on table vortex_access.capability_reservations is
  'Atomic capability quantity reservations against effective capability policies.';
comment on table vortex_access.capability_reservation_operations is
  'Idempotent consumption and release operations bounded by capability reservations.';
comment on function vortex_access.expire_stale_capability_reservations(uuid, uuid) is
  'Expires active reservations past their deadline and recalculates balances.';
comment on function vortex_access.reserve_capability_quantity is
  'Atomically locks policy balance, expires stale reservations, checks policy evidence, and reserves quantity.';
comment on function vortex_access.consume_capability_reservation is
  'Atomically consumes reserved quantity, bounded by reservation amount and scoped to exact subject and policy.';
comment on function vortex_access.release_capability_reservation is
  'Atomically releases unconsumed reserved quantity back to available policy capacity.';
comment on function vortex_access.read_capability_reservation_balance is
  'Reads current locked capability balances for effective policy scope.';
