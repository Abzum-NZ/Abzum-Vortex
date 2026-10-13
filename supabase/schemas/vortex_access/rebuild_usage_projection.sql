CREATE OR REPLACE FUNCTION vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  source_count bigint;
  discrepancy_count integer;
  discrepancy_alerts jsonb;
begin
  if p_identity_id is null or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_period_start is null or p_period_end is null or p_period_start >= p_period_end
    or p_period_end - p_period_start > interval '366 days'
    or p_period_start <> (pg_catalog.date_trunc('day', p_period_start at time zone 'UTC') at time zone 'UTC')
    or p_period_end <> (pg_catalog.date_trunc('day', p_period_end at time zone 'UTC') at time zone 'UTC') then
    raise exception using errcode = '22023', message = 'Usage projection request is invalid';
  end if;
  -- Tenant manage is the same existing structural authority used by capability
  -- policy administration. It is re-evaluated for every rebuild from current facts.
  perform vortex_identity.require_current_tenant_capability(
    p_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('usage-projection:' || p_tenant_id::text, 752)
  );

  delete from vortex_access.usage_projection_rollups as rollup
  where rollup.tenant_id = p_tenant_id
    and rollup.bucket_start >= p_period_start and rollup.bucket_start < p_period_end;

  insert into vortex_access.usage_projection_rollups (
    tenant_id, rollup_scope, scope_id, organization_id, bucket_start, capability_key, unit,
    quantity, accepted_event_count
  )
  select p_tenant_id, derived.rollup_scope, derived.scope_id, derived.organization_id,
    derived.bucket_start, derived.capability_key, derived.unit, derived.quantity,
    derived.accepted_event_count
  from vortex_access.derive_usage_projection(p_tenant_id, p_period_start, p_period_end) as derived;

  -- Reconcile the stored tenant and organisation rollups against a fresh
  -- derivation from the accepted ledger in a later statement snapshot. Events or
  -- corrections accepted after the rebuild snapshot, or any divergence between
  -- the two rollup levels, surface as bounded safe alerts and a stale state.
  with derived as (
    select * from vortex_access.derive_usage_projection(p_tenant_id, p_period_start, p_period_end)
  ), stored as (
    select rollup.rollup_scope, rollup.scope_id, rollup.bucket_start, rollup.capability_key,
      rollup.unit, rollup.quantity, rollup.accepted_event_count
    from vortex_access.usage_projection_rollups as rollup
    where rollup.tenant_id = p_tenant_id
      and rollup.bucket_start >= p_period_start and rollup.bucket_start < p_period_end
  ), mismatches as (
    select coalesce(derived.bucket_start, stored.bucket_start) as bucket_start
    from derived full join stored
      on stored.rollup_scope = derived.rollup_scope
      and stored.scope_id = derived.scope_id
      and stored.bucket_start = derived.bucket_start
      and stored.capability_key = derived.capability_key
      and stored.unit = derived.unit
    where derived.quantity is distinct from stored.quantity
      or derived.accepted_event_count is distinct from stored.accepted_event_count
  )
  select
    (select coalesce(pg_catalog.sum(derived.accepted_event_count), 0)::bigint
      from derived where derived.rollup_scope = 'tenant'),
    (select pg_catalog.count(*)::integer from mismatches),
    (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'code', 'usage_rollup_mismatch', 'bucketStart', alert.bucket_start
      ) order by alert.bucket_start), '[]'::jsonb)
      from (
        select distinct mismatches.bucket_start from mismatches
        order by mismatches.bucket_start limit 20
      ) as alert)
  into source_count, discrepancy_count, discrepancy_alerts;

  insert into vortex_access.usage_projection_reconciliation (
    tenant_id, period_start, period_end, rebuilt_at, source_event_count, discrepancy_count, alerts
  ) values (p_tenant_id, p_period_start, p_period_end, evaluated_at, source_count, discrepancy_count, discrepancy_alerts)
  on conflict (tenant_id, period_start, period_end) do update set rebuilt_at = excluded.rebuilt_at,
    source_event_count = excluded.source_event_count,
    discrepancy_count = excluded.discrepancy_count, alerts = excluded.alerts;
end
$$;

alter function vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) FROM PUBLIC;

grant execute on function vortex_access.rebuild_usage_projection(p_identity_id uuid, p_tenant_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone) to postgres;
