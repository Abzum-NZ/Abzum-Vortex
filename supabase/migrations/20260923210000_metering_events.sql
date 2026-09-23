-- Append-only metering events (#751). Generic usage evidence only: stable
-- duplicate identity, capability, positive quantity and unit, occurrence time,
-- safe bounded dimensions, tenant/optional organisation, source/correlation and
-- one allocation owner. It carries no prices, invoices, provider identifiers,
-- secrets, arbitrary payloads or commercial status. Corrections are later
-- linked events; an accepted event is never updated or deleted.

-- Safe dimensions are a small, flat map of bounded scalars. Nested objects,
-- arrays, nulls, unbounded text and control characters are refused.
create function vortex_access.metering_event_dimensions_are_valid(p_dimensions jsonb)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select pg_catalog.jsonb_typeof(p_dimensions) = 'object'
    and pg_catalog.pg_column_size(p_dimensions) <= 4096
    and (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(p_dimensions)
    ) <= 16
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_dimensions) as entry(key, value)
      where pg_catalog.length(entry.key) > 40
        or entry.key !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
        or not (
          (pg_catalog.jsonb_typeof(entry.value) = 'string'
            and pg_catalog.length(entry.value #>> '{}') between 1 and 200
            and (entry.value #>> '{}') !~ '[[:cntrl:]]')
          or pg_catalog.jsonb_typeof(entry.value) = 'boolean'
          or (pg_catalog.jsonb_typeof(entry.value) = 'number'
            and (entry.value #>> '{}') ~ '^-?[0-9]+$'
            and (entry.value #>> '{}')::numeric
              between -9007199254740991 and 9007199254740991
            and (entry.value #>> '{}')::numeric
              = ((entry.value #>> '{}')::numeric::float8)::numeric)
        )
    );
$function$;

create table vortex_access.metering_events (
  metering_event_id uuid not null primary key,
  operation_id uuid not null,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  organization_id uuid references vortex_identity.organizations (organization_id),
  allocation_owner text not null,
  capability_key text not null,
  quantity numeric not null,
  unit text not null,
  source text not null,
  dimensions jsonb not null,
  occurred_at timestamptz not null,
  source_event_id uuid,
  duplicate_protection_key text not null,
  command_fingerprint text not null,
  correlation_id uuid not null,
  corrects_metering_event_id uuid,
  accepted_at timestamptz not null,
  result jsonb not null,
  constraint metering_events_ids_non_nil check (
    vortex_context.is_non_nil_uuid(metering_event_id::text)
    and vortex_context.is_non_nil_uuid(operation_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and (source_event_id is null or vortex_context.is_non_nil_uuid(source_event_id::text))
    and vortex_context.is_non_nil_uuid(correlation_id::text)
    and (corrects_metering_event_id is null
      or vortex_context.is_non_nil_uuid(corrects_metering_event_id::text))
  ),
  constraint metering_events_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
  ),
  constraint metering_events_quantity_valid check (
    vortex_access.capability_policy_quantity_is_valid(quantity)
  ),
  constraint metering_events_source_allocation_valid check (
    source in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
    and allocation_owner in ('local', 'federated_source', 'federated_recipient')
    and ((source = 'federation'
        and allocation_owner in ('federated_source', 'federated_recipient'))
      or (source <> 'federation' and allocation_owner = 'local'))
  ),
  constraint metering_events_dimensions_valid check (
    vortex_access.metering_event_dimensions_are_valid(dimensions)
  ),
  constraint metering_events_duplicate_key_valid check (
    duplicate_protection_key = pg_catalog.btrim(duplicate_protection_key)
    and pg_catalog.length(duplicate_protection_key) between 16 and 200
  ),
  constraint metering_events_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint metering_events_times_valid check (
    occurred_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and accepted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint metering_events_result_valid check (
    pg_catalog.jsonb_typeof(result) = 'object'
    and result ?& array[
      'meteringEventId', 'operationId', 'tenantId', 'allocationOwner',
      'capabilityKey', 'quantity', 'unit', 'occurredAt', 'source',
      'dimensions', 'duplicateProtectionKey', 'correlationId', 'acceptedAt'
    ]
    and (result ->> 'meteringEventId')::uuid is not distinct from metering_event_id
    and (result ->> 'tenantId')::uuid is not distinct from tenant_id
    and (result ->> 'quantity')::numeric is not distinct from quantity
  ),
  foreign key (corrects_metering_event_id)
    references vortex_access.metering_events (metering_event_id)
);

-- One duplicate-protection key per tenant and organisation scope owns exactly
-- one immutable event, so a replayed command cannot double count.
create unique index metering_events_duplicate_scope_unique
  on vortex_access.metering_events (
    tenant_id,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    duplicate_protection_key
  );
create index metering_events_scope_occurred_idx
  on vortex_access.metering_events (
    tenant_id,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key,
    unit,
    occurred_at
  );
create index metering_events_operation_idx
  on vortex_access.metering_events (tenant_id, operation_id);
create index metering_events_correlation_idx
  on vortex_access.metering_events (correlation_id);
create index metering_events_correction_idx
  on vortex_access.metering_events (corrects_metering_event_id)
  where corrects_metering_event_id is not null;

alter table vortex_access.metering_events enable row level security;
alter table vortex_access.metering_events force row level security;

revoke all on table vortex_access.metering_events
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create function vortex_access.refuse_metering_event_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'Metering event evidence is immutable';
end
$function$;

create trigger metering_events_immutable
before update or delete on vortex_access.metering_events
for each row execute function vortex_access.refuse_metering_event_change();

-- The established request context supplies tenant, organisation and correlation
-- authority. The caller supplies correlation only as a cross-check and cannot
-- attribute usage to another tenant, organisation or correlation.
create function vortex_access.record_metering_event(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_allocation_owner text,
  p_operation_id uuid,
  p_capability_key text,
  p_quantity numeric,
  p_unit text,
  p_source text,
  p_dimensions jsonb,
  p_occurred_at timestamptz,
  p_source_event_id uuid,
  p_duplicate_protection_key text,
  p_correlation_id uuid,
  p_corrects_metering_event_id uuid
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  accepted_at_value timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  existing vortex_access.metering_events%rowtype;
  metering_event_id uuid;
  command_fingerprint text;
  safe_event jsonb;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_allocation_owner is null
    or p_allocation_owner not in ('local', 'federated_source', 'federated_recipient')
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_source is null
    or p_source not in ('web', 'workflow', 'interface', 'connection', 'federation', 'system')
    or not vortex_access.metering_event_dimensions_are_valid(p_dimensions)
    or p_occurred_at is null
    or p_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_source_event_id is not null
      and not vortex_context.is_non_nil_uuid(p_source_event_id::text))
    or p_duplicate_protection_key is null
    or p_duplicate_protection_key <> pg_catalog.btrim(p_duplicate_protection_key)
    or pg_catalog.length(p_duplicate_protection_key) not between 16 and 200
    or p_correlation_id is null
    or not vortex_context.is_non_nil_uuid(p_correlation_id::text)
    or (p_corrects_metering_event_id is not null
      and not vortex_context.is_non_nil_uuid(p_corrects_metering_event_id::text)) then
    raise exception using errcode = '22023', message = 'Metering event command is invalid';
  end if;
  if (p_source = 'federation'
      and p_allocation_owner not in ('federated_source', 'federated_recipient'))
    or (p_source <> 'federation' and p_allocation_owner <> 'local') then
    raise exception using errcode = '22023', message = 'Metering event allocation is invalid';
  end if;
  established := vortex_context.current_context();
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null
      and (established ->> 'organizationId')::uuid is distinct from p_organization_id)
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_corrects_metering_event_id is not null and not exists (
    select 1 from vortex_access.metering_events as corrected
    where corrected.metering_event_id = p_corrects_metering_event_id
      and corrected.tenant_id = p_tenant_id
  ) then
    raise exception using errcode = '22023', message = 'Metering correction target is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'record_metering_event', p_tenant_id::text,
      coalesce(p_organization_id::text, ''), p_allocation_owner,
      p_operation_id::text, p_capability_key, p_quantity::text, p_unit,
      p_source, p_dimensions::text, p_occurred_at::text,
      coalesce(p_source_event_id::text, ''),
      p_duplicate_protection_key, p_correlation_id::text,
      coalesce(p_corrects_metering_event_id::text, '')), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(p_organization_id::text, ''), p_duplicate_protection_key), 751)
  );
  select stored.* into existing
  from vortex_access.metering_events as stored
  where stored.tenant_id = p_tenant_id
    and stored.organization_id is not distinct from p_organization_id
    and stored.duplicate_protection_key = p_duplicate_protection_key;
  if found then
    if existing.command_fingerprint <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Metering event duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_build_object(
      'status', 'replayed', 'event', existing.result
    );
    return;
  end if;
  metering_event_id := pg_catalog.gen_random_uuid();
  safe_event := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'meteringEventId', metering_event_id,
    'operationId', p_operation_id,
    'tenantId', p_tenant_id,
    'organizationId', p_organization_id,
    'allocationOwner', p_allocation_owner,
    'capabilityKey', p_capability_key,
    'quantity', p_quantity::float8,
    'unit', p_unit,
    'occurredAt', pg_catalog.to_char(p_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'source', p_source,
    'sourceEventId', p_source_event_id,
    'dimensions', p_dimensions,
    'duplicateProtectionKey', p_duplicate_protection_key,
    'correlationId', p_correlation_id,
    'correctsMeteringEventId', p_corrects_metering_event_id,
    'acceptedAt', pg_catalog.to_char(accepted_at_value at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
  insert into vortex_access.metering_events (
    metering_event_id, operation_id, tenant_id, organization_id,
    allocation_owner, capability_key, quantity, unit, source, dimensions,
    occurred_at, source_event_id, duplicate_protection_key,
    command_fingerprint, correlation_id, corrects_metering_event_id,
    accepted_at, result
  ) values (
    metering_event_id, p_operation_id, p_tenant_id, p_organization_id,
    p_allocation_owner, p_capability_key, p_quantity, p_unit, p_source,
    p_dimensions, p_occurred_at, p_source_event_id, p_duplicate_protection_key,
    command_fingerprint, p_correlation_id, p_corrects_metering_event_id,
    accepted_at_value, safe_event
  );
  return query select pg_catalog.jsonb_build_object(
    'status', 'accepted', 'event', safe_event
  );
end
$function$;

alter table vortex_access.metering_events owner to postgres;
alter function vortex_access.metering_event_dimensions_are_valid(jsonb)
  owner to postgres;
alter function vortex_access.refuse_metering_event_change() owner to postgres;
alter function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid
) owner to postgres;

revoke execute on function
  vortex_access.metering_event_dimensions_are_valid(jsonb),
  vortex_access.refuse_metering_event_change(),
  vortex_access.record_metering_event(
    uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
    uuid, text, uuid, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid
) to vortex_request;

comment on table vortex_access.metering_events is
  'Immutable generic usage evidence keyed by one stable duplicate-protection scope; no commercial or provider state.';
comment on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid
) is
  'Appends exactly one immutable metering event for a committed operation or replays the original event for a repeated duplicate key.';
