CREATE FUNCTION vortex_access.derive_usage_projection(p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS TABLE(rollup_scope text, scope_id uuid, organization_id uuid, bucket_start timestamp with time zone, capability_key text, unit text, quantity numeric, accepted_event_count bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  with accepted as (
    select original.organization_id,
      (pg_catalog.date_trunc('day', original.occurred_at at time zone 'UTC') at time zone 'UTC') as bucket_start,
      original.capability_key, original.unit,
      original.quantity + coalesce(pg_catalog.sum(case correction.correction_direction
        when 'increase' then correction.quantity else -correction.quantity end), 0) as net_quantity,
      1 + pg_catalog.count(correction.metering_event_id) as accepted_event_count
    from vortex_access.metering_events as original
    left join vortex_access.metering_events as correction
      on correction.tenant_id = original.tenant_id
      and correction.corrects_metering_event_id = original.metering_event_id
    where original.tenant_id = p_tenant_id and original.corrects_metering_event_id is null
      and original.occurred_at >= p_period_start and original.occurred_at < p_period_end
    group by original.metering_event_id
  ), scoped as (
    select 'tenant'::text as rollup_scope,
      '00000000-0000-0000-0000-000000000000'::uuid as scope_id, null::uuid as organization_id,
      bucket_start, capability_key, unit, net_quantity, accepted_event_count
    from accepted
    union all
    select 'organization'::text, organization_id, organization_id,
      bucket_start, capability_key, unit, net_quantity, accepted_event_count
    from accepted where organization_id is not null
  )
  select rollup_scope, scope_id, organization_id, bucket_start, capability_key, unit,
    pg_catalog.sum(net_quantity), pg_catalog.sum(accepted_event_count)::bigint
  from scoped
  group by rollup_scope, scope_id, organization_id, bucket_start, capability_key, unit;
$$;


ALTER FUNCTION vortex_access.derive_usage_projection(p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.derive_usage_projection(p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) FROM PUBLIC;
