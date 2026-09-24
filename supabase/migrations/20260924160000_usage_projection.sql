-- Rebuildable usage read model. The append-only accepted event ledger remains
-- the sole source of totals; these rows are disposable projections.
begin;

create table vortex_access.usage_projection_rollups (
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  rollup_scope text not null,
  scope_id uuid not null,
  organization_id uuid,
  bucket_start timestamptz not null,
  capability_key text not null,
  unit text not null,
  quantity numeric not null,
  accepted_event_count bigint not null,
  constraint usage_projection_rollups_scope_valid check (
    vortex_context.is_non_nil_uuid(tenant_id::text)
    and rollup_scope in ('tenant', 'organization')
    and ((rollup_scope = 'tenant' and organization_id is null
        and scope_id = '00000000-0000-0000-0000-000000000000'::uuid)
      or (rollup_scope = 'organization' and organization_id is not null
        and scope_id = organization_id))
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and (organization_id is null or bucket_start is not null)
    and accepted_event_count >= 0
  ),
  constraint usage_projection_rollups_organization_fk foreign key (tenant_id, organization_id)
    references vortex_identity.organizations (tenant_id, organization_id),
  primary key (tenant_id, rollup_scope, scope_id, bucket_start, capability_key, unit)
);

create table vortex_access.usage_projection_reconciliation (
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  rebuilt_at timestamptz not null,
  source_event_count bigint not null,
  discrepancy_count integer not null,
  alerts jsonb not null,
  constraint usage_projection_reconciliation_valid check (
    period_start < period_end and period_end - period_start <= interval '366 days'
    and source_event_count >= 0 and discrepancy_count >= 0
    and pg_catalog.jsonb_typeof(alerts) = 'array'
    and pg_catalog.jsonb_array_length(alerts) <= 20
  ),
  primary key (tenant_id, period_start, period_end)
);

alter table vortex_access.usage_projection_rollups enable row level security;
alter table vortex_access.usage_projection_rollups force row level security;
alter table vortex_access.usage_projection_reconciliation enable row level security;
alter table vortex_access.usage_projection_reconciliation force row level security;
revoke all on table vortex_access.usage_projection_rollups,
  vortex_access.usage_projection_reconciliation
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

-- Private derivation shared by rebuild and reconciliation. Each accepted
-- original event counts once, with its accepted corrections netted into the
-- original's UTC day; the tenant scope covers every event and the organisation
-- scope only events attributed to that organisation.
create function vortex_access.derive_usage_projection(
  p_tenant_id uuid, p_period_start timestamptz, p_period_end timestamptz
)
returns table (
  rollup_scope text,
  scope_id uuid,
  organization_id uuid,
  bucket_start timestamptz,
  capability_key text,
  unit text,
  quantity numeric,
  accepted_event_count bigint
)
language sql stable security invoker set search_path = ''
as $function$
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
$function$;

create function vortex_access.rebuild_usage_projection(
  p_identity_id uuid, p_tenant_id uuid, p_period_start timestamptz, p_period_end timestamptz
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  source_count bigint;
  discrepancy_count integer;
  discrepancy_alerts jsonb;
begin
  if p_identity_id is null or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
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
$function$;

create function vortex_access.read_usage_projection(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_scope text,
  p_organization_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_grouping text,
  p_page_size integer,
  p_cursor text default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
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
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text)) then
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
$function$;

alter table vortex_access.usage_projection_rollups owner to postgres;
alter table vortex_access.usage_projection_reconciliation owner to postgres;
alter function vortex_access.derive_usage_projection(uuid, timestamptz, timestamptz) owner to postgres;
alter function vortex_access.rebuild_usage_projection(uuid, uuid, timestamptz, timestamptz) owner to postgres;
alter function vortex_access.read_usage_projection(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, text) owner to postgres;
revoke all on function vortex_access.derive_usage_projection(uuid, timestamptz, timestamptz),
  vortex_access.rebuild_usage_projection(uuid, uuid, timestamptz, timestamptz),
  vortex_access.read_usage_projection(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.read_usage_projection(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, text)
to vortex_runtime;

comment on table vortex_access.usage_projection_rollups is
  'Disposable day-level tenant and organisation usage projections rebuilt only from accepted metering events.';
comment on table vortex_access.usage_projection_reconciliation is
  'Latest accepted-event rebuild watermark and discrepancy alerts for usage projections.';
comment on function vortex_access.read_usage_projection(uuid, uuid, text, uuid, timestamptz, timestamptz, text, integer, text) is
  'Rebuilds accepted-event usage projections after current tenant-administrator authorization and returns one bounded tenant or organisation aggregate page.';

commit;
