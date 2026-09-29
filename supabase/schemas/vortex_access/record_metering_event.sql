create or replace function vortex_access.record_metering_event(
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
  p_corrects_metering_event_id uuid,
  p_correction_direction text
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  accepted_at_value timestamptz := pg_catalog.clock_timestamp();
  established jsonb;
  existing vortex_access.metering_events%rowtype;
  corrected vortex_access.metering_events%rowtype;
  corrected_remaining numeric;
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
      and not vortex_context.is_non_nil_uuid(p_corrects_metering_event_id::text))
    or ((p_corrects_metering_event_id is null) <> (p_correction_direction is null))
    or (p_correction_direction is not null
      and p_correction_direction not in ('increase', 'decrease')) then
    raise exception using errcode = '22023', message = 'Metering event command is invalid';
  end if;
  if (p_source = 'federation'
      and p_allocation_owner not in ('federated_source', 'federated_recipient'))
    or (p_source <> 'federation' and p_allocation_owner <> 'local') then
    raise exception using errcode = '22023', message = 'Metering event allocation is invalid';
  end if;
  established := vortex_context.current_context();
  if (established ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (established ->> 'organizationId')::uuid is distinct from p_organization_id
    or (established ->> 'correlationId')::uuid is distinct from p_correlation_id then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  -- Corrections and non-web sources are system operations. A human, federated
  -- or public request context can never fabricate system/federation usage or
  -- reduce recorded usage.
  if (established ->> 'callerKind') is distinct from 'system'
    and (p_source <> 'web' or p_corrects_metering_event_id is not null) then
    raise exception using errcode = '42501',
      message = 'Metering event authority is unavailable';
  end if;
  -- Key-share locks keep the attributed scope present without serialising the
  -- tenant's other writes behind every metered operation.
  perform 1 from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
    for key share;
    if not found then
      raise exception using errcode = '42501', message = 'Metering event scope is unavailable';
    end if;
  end if;
  -- The fingerprint covers the metered fact, not the delivering request, so a
  -- redelivery under a new correlation replays instead of conflicting.
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'record_metering_event', p_tenant_id::text,
      coalesce(p_organization_id::text, ''), p_allocation_owner,
      p_operation_id::text, p_capability_key, p_quantity::text, p_unit,
      p_source, p_dimensions::text,
      pg_catalog.to_char(p_occurred_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      coalesce(p_source_event_id::text, ''),
      p_duplicate_protection_key,
      coalesce(p_corrects_metering_event_id::text, ''),
      coalesce(p_correction_direction, '')), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', 'duplicate',
      p_tenant_id::text, p_duplicate_protection_key), 751)
  );
  select stored.* into existing
  from vortex_access.metering_events as stored
  where stored.tenant_id = p_tenant_id
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
  -- Second lock, always taken after the duplicate lock: an original serialises
  -- on its final operation identity, a correction on the event it corrects.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      case when p_corrects_metering_event_id is null then
        pg_catalog.concat_ws(E'\x1f', 'operation', p_tenant_id::text,
          p_operation_id::text, p_capability_key, p_unit)
      else
        pg_catalog.concat_ws(E'\x1f', 'correction', p_tenant_id::text,
          p_corrects_metering_event_id::text)
      end, 751)
  );
  if p_corrects_metering_event_id is null then
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.operation_id = p_operation_id
        and stored.capability_key = p_capability_key
        and stored.unit = p_unit
        and stored.corrects_metering_event_id is null
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
  else
    select stored.* into corrected
    from vortex_access.metering_events as stored
    where stored.tenant_id = p_tenant_id
      and stored.metering_event_id = p_corrects_metering_event_id;
    -- A correction targets an original event with the same attribution,
    -- allocation, capability and unit, so it never moves usage elsewhere.
    if not found
      or corrected.corrects_metering_event_id is not null
      or corrected.organization_id is distinct from p_organization_id
      or corrected.allocation_owner <> p_allocation_owner
      or corrected.capability_key <> p_capability_key
      or corrected.unit <> p_unit then
      raise exception using errcode = '22023', message = 'Metering correction target is unavailable';
    end if;
    if exists (
      select 1 from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id
        and stored.operation_id = p_operation_id
    ) then
      raise exception using errcode = 'V3001', message = 'Metering operation is already recorded';
    end if;
    if p_correction_direction = 'decrease' then
      select corrected.quantity + coalesce(pg_catalog.sum(
          case stored.correction_direction
            when 'increase' then stored.quantity
            else -stored.quantity
          end), 0)
      into corrected_remaining
      from vortex_access.metering_events as stored
      where stored.tenant_id = p_tenant_id
        and stored.corrects_metering_event_id = p_corrects_metering_event_id;
      if p_quantity > corrected_remaining then
        raise exception using errcode = '22023',
          message = 'Metering correction exceeds the recorded quantity';
      end if;
    end if;
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
    'correctionDirection', p_correction_direction,
    'acceptedAt', pg_catalog.to_char(accepted_at_value at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ));
  insert into vortex_access.metering_events (
    metering_event_id, operation_id, tenant_id, organization_id,
    allocation_owner, capability_key, quantity, unit, source, dimensions,
    occurred_at, source_event_id, duplicate_protection_key,
    command_fingerprint, correlation_id, corrects_metering_event_id,
    correction_direction, accepted_at, result
  ) values (
    metering_event_id, p_operation_id, p_tenant_id, p_organization_id,
    p_allocation_owner, p_capability_key, p_quantity, p_unit, p_source,
    p_dimensions, p_occurred_at, p_source_event_id, p_duplicate_protection_key,
    command_fingerprint, p_correlation_id, p_corrects_metering_event_id,
    p_correction_direction, accepted_at_value, safe_event
  );
  return query select pg_catalog.jsonb_build_object(
    'status', 'accepted', 'event', safe_event
  );
end
$function$;

comment on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid, text
) is
  'Appends exactly one immutable metering event for a committed operation or replays the original event for a repeated duplicate key.';

revoke execute on function
  vortex_access.record_metering_event(
    uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
    uuid, text, uuid, uuid, text
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_access.record_metering_event(
  uuid, uuid, text, uuid, text, numeric, text, text, jsonb, timestamptz,
  uuid, text, uuid, uuid, text
) to vortex_request;
