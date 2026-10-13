CREATE OR REPLACE FUNCTION vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  after_value jsonb;
  selected record;
  bucket_values jsonb;
  next_value text;
  has_more boolean := false;
  reconciliation vortex_access.usage_projection_reconciliation%rowtype;
begin
  if p_scope is null or p_scope not in ('tenant', 'organization')
    or ((p_scope = 'organization') <> (p_organization_id is not null))
    or p_period_start is null or p_period_end is null
    or p_period_start >= p_period_end
    or p_period_end - p_period_start > interval '366 days'
    or p_period_start <> (pg_catalog.date_trunc('day', p_period_start at time zone 'UTC') at time zone 'UTC')
    or p_period_end <> (pg_catalog.date_trunc('day', p_period_end at time zone 'UTC') at time zone 'UTC')
    or p_grouping is null or p_grouping not in ('day', 'week', 'month')
    or p_page_size is null or p_page_size not between 1 and 100
    or (p_cursor is not null and pg_catalog.length(p_cursor) > 2048)
    or (p_organization_id is not null and not vortex_platform.is_non_nil_uuid(p_organization_id::text)) then
    raise exception using errcode = '22023', message = 'Usage projection request is invalid';
  end if;
  if p_cursor is not null then
    begin
      after_value := p_cursor::jsonb;
    exception when others then
      raise exception using errcode = '22023', message = 'Usage projection cursor is invalid';
    end;
    if pg_catalog.jsonb_typeof(after_value) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Usage projection cursor is invalid';
    end if;
    if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(after_value)) <> 3
      or pg_catalog.jsonb_typeof(after_value -> 'periodStart') is distinct from 'string'
      or pg_catalog.jsonb_typeof(after_value -> 'capabilityKey') is distinct from 'string'
      or pg_catalog.jsonb_typeof(after_value -> 'unit') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Usage projection cursor is invalid';
    end if;
  end if;
  perform vortex_access.rebuild_usage_projection(p_identity_id, p_tenant_id, p_period_start, p_period_end);
  select * into strict reconciliation from vortex_access.usage_projection_reconciliation
  where tenant_id = p_tenant_id and period_start = p_period_start and period_end = p_period_end;

  for selected in
    -- A week or month that begins before the requested period is reported from
    -- the period start, so no bucket claims usage outside the period.
    with grouped as (
      select greatest(
          pg_catalog.date_trunc(p_grouping, rollup.bucket_start at time zone 'UTC') at time zone 'UTC',
          p_period_start
        ) as period_start,
        rollup.capability_key, rollup.unit, sum(rollup.quantity) as quantity,
        sum(rollup.accepted_event_count)::bigint as accepted_event_count
      from vortex_access.usage_projection_rollups rollup
      where rollup.tenant_id = p_tenant_id
        and rollup.rollup_scope = p_scope
        and rollup.scope_id = case when p_scope = 'organization' then p_organization_id else '00000000-0000-0000-0000-000000000000'::uuid end
        and rollup.organization_id is not distinct from case when p_scope = 'organization' then p_organization_id else null end
        and rollup.bucket_start >= p_period_start and rollup.bucket_start < p_period_end
      group by 1, rollup.capability_key, rollup.unit
    )
    select * from grouped
    where after_value is null or (period_start, capability_key, unit) > (
      (after_value ->> 'periodStart')::timestamptz,
      after_value ->> 'capabilityKey', after_value ->> 'unit'
    )
    order by period_start, capability_key, unit
    limit p_page_size + 1
  loop
    if pg_catalog.jsonb_array_length(coalesce(bucket_values, '[]'::jsonb)) >= p_page_size then
      has_more := true;
      exit;
    end if;
    bucket_values := coalesce(bucket_values, '[]'::jsonb) || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'periodStart', selected.period_start,
        'capabilityKey', selected.capability_key,
        'unit', selected.unit,
        'quantity', selected.quantity::text,
        'acceptedEventCount', selected.accepted_event_count::text
      ) || case when p_scope = 'organization'
        then pg_catalog.jsonb_build_object('organizationId', p_organization_id) else '{}'::jsonb end
    );
    next_value := pg_catalog.jsonb_build_object(
      'periodStart', selected.period_start,
      'capabilityKey', selected.capability_key,
      'unit', selected.unit
    )::text;
  end loop;
  if not has_more then next_value := null; end if;
  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'scope', p_scope,
    'buckets', coalesce(bucket_values, '[]'::jsonb),
    'reconciliation', pg_catalog.jsonb_build_object(
      'state', case when reconciliation.discrepancy_count = 0 then 'reconciled' else 'discrepancy' end,
      'freshness', case when reconciliation.discrepancy_count = 0 then 'current' else 'stale' end,
      'source', 'accepted_events', 'observedAt', reconciliation.rebuilt_at,
      'discrepancyCount', reconciliation.discrepancy_count, 'alerts', reconciliation.alerts
    ),
    'nextCursor', next_value
  ));
end
$$;

ALTER FUNCTION vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) IS 'Rebuilds accepted-event usage projections after current tenant-administrator authorization and returns one bounded tenant or organisation aggregate page.';

REVOKE ALL ON FUNCTION vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_scope text, p_organization_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_grouping text, p_page_size integer, p_cursor text) TO vortex_runtime;
