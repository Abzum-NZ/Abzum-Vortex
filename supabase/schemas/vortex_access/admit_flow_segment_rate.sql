create or replace function vortex_access.admit_flow_segment_rate(
  p_kind text
)
returns table (admitted boolean, retry_after_seconds integer)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  v_tenant_id uuid := (context_value ->> 'tenantId')::uuid;
  v_organization_id uuid := (context_value ->> 'organizationId')::uuid;
  v_account_id uuid := (context_value ->> 'organizationAccountId')::uuid;
  v_correlation_id uuid := (context_value ->> 'correlationId')::uuid;
  v_evaluated_at timestamptz;
  v_window_start timestamptz;
  v_kind text := case when vortex_platform.channel() = 'mcp' then 'mcp' else p_kind end;
  v_account_limit integer;
  v_organization_limit integer;
  v_account_count integer;
  v_organization_count integer;
  v_refusal_id uuid;
begin
  if p_kind is null or p_kind not in ('change', 'read') then
    raise exception using errcode = '22023', message = 'Flow segment rate command is invalid';
  end if;
  select defaults.account_limit, defaults.organization_limit
    into strict v_account_limit, v_organization_limit
  from vortex_access.flow_segment_rate_defaults as defaults
  where defaults.kind = v_kind;

  -- Lock in the same order for all callers: organisation bucket, then account bucket.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.concat_ws(E'\x1f', v_organization_id::text, v_kind), 817
  ));
  v_evaluated_at := pg_catalog.clock_timestamp();
  v_window_start := pg_catalog.date_trunc('minute', v_evaluated_at);
  delete from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id
    and bucket.kind = v_kind
    and bucket.window_start < v_window_start - interval '2 minutes';
  insert into vortex_access.flow_segment_rate_buckets
    (organization_id, organization_account_id, kind, window_start, used)
  values (v_organization_id, null, v_kind, v_window_start, 0),
    (v_organization_id, v_account_id, v_kind, v_window_start, 0)
  on conflict (organization_id, organization_account_id, kind, window_start) do nothing;

  select bucket.used into strict v_organization_count
  from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id and bucket.organization_account_id is null
    and bucket.kind = v_kind and bucket.window_start = v_window_start;
  select bucket.used into strict v_account_count
  from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id and bucket.organization_account_id = v_account_id
    and bucket.kind = v_kind and bucket.window_start = v_window_start;
  if v_organization_count >= v_organization_limit or v_account_count >= v_account_limit then
    v_refusal_id := pg_catalog.gen_random_uuid();
    perform vortex_access.record_metering_event(
      v_tenant_id, v_organization_id, 'local', v_refusal_id, 'flow.rate_limit_refused',
      1, 'segment', 'web', pg_catalog.jsonb_build_object('kind', v_kind), v_evaluated_at,
      null, 'flow-rate:' || v_refusal_id::text, v_correlation_id, null, null
    );
    return query select false,
      greatest(1, pg_catalog.ceil(extract(epoch from
        (v_window_start + interval '1 minute' - v_evaluated_at)))::integer);
    return;
  end if;
  update vortex_access.flow_segment_rate_buckets as bucket
  set used = bucket.used + 1
  where bucket.organization_id = v_organization_id and bucket.kind = v_kind
    and bucket.window_start = v_window_start
    and (bucket.organization_account_id is null or bucket.organization_account_id = v_account_id);
  return query select true, 0;
end
$function$;

comment on function vortex_access.admit_flow_segment_rate(text) is
  'Checks and increments current account and organisation flow-segment minute buckets atomically.';
revoke execute on function vortex_access.admit_flow_segment_rate(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.admit_flow_segment_rate(text) to vortex_request;
alter function vortex_access.admit_flow_segment_rate(text) owner to vortex_owner;
grant execute on function vortex_access.admit_flow_segment_rate(text) to postgres;
