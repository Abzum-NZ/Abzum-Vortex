set role vortex_owner;

create or replace function vortex_platform.begin_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_principal_kind text,
  p_principal_id uuid,
  p_origin_kind text,
  p_origin_id uuid,
  p_task_path text,
  p_iteration text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  inserted_run_id uuid;
  existing record;
begin
  if p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'system')
    or p_principal_id is null
    or not vortex_platform.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_platform.is_non_nil_uuid(p_origin_id::text)
    or (p_origin_kind = 'person' and (
      p_principal_kind <> 'person' or p_origin_id <> p_principal_id
    ))
    or (p_origin_kind in ('event', 'schedule') and p_principal_kind = 'person')
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  insert into vortex_platform.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id,
    principal_kind, principal_id, origin_kind, origin_id, state, started_at
  ) values (
    p_run_id, p_task_path, p_iteration, p_organization_id,
    case when p_principal_kind = 'person' then p_principal_id else null end,
    p_principal_kind, p_principal_id, p_origin_kind, p_origin_id, 'started',
    pg_catalog.statement_timestamp()
  )
  on conflict (run_id, task_path, iteration) do nothing
  returning run_id into inserted_run_id;

  if inserted_run_id is not null then
    return pg_catalog.jsonb_build_object('kind', 'claimed');
  end if;

  select ledger.organization_id, ledger.identity_id, ledger.principal_kind,
    ledger.principal_id, ledger.origin_kind, ledger.origin_id,
    ledger.state, ledger.outcome, ledger.outputs
  into existing
  from vortex_platform.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;

  if not found
    or existing.organization_id is distinct from p_organization_id
    or existing.principal_kind is distinct from p_principal_kind
    or existing.principal_id is distinct from p_principal_id
    or existing.origin_kind is distinct from p_origin_kind
    or existing.origin_id is distinct from p_origin_id then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  if existing.state = 'completed' then
    return pg_catalog.jsonb_build_object(
      'kind', 'completed',
      'outcome', existing.outcome,
      'outputs', coalesce(existing.outputs, '{}'::jsonb)
    );
  end if;
  return pg_catalog.jsonb_build_object('kind', 'in_progress');
end
$function$;
alter function vortex_platform.begin_flow_effect(uuid,uuid,text,uuid,text,uuid,text,text)
  owner to vortex_owner;

revoke all on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) to vortex_runtime;

comment on function vortex_platform.begin_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text
) is
  'Private effect claim bound to a verified person or execution principal and trigger origin; the run, task path and iteration remain duplicate-safe.';

create or replace function vortex_platform.complete_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_principal_kind text,
  p_principal_id uuid,
  p_origin_kind text,
  p_origin_id uuid,
  p_task_path text,
  p_iteration text,
  p_outcome text,
  p_outputs jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'system')
    or p_principal_id is null
    or not vortex_platform.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_platform.is_non_nil_uuid(p_origin_id::text)
    or (p_origin_kind = 'person' and (
      p_principal_kind <> 'person' or p_origin_id <> p_principal_id
    ))
    or (p_origin_kind in ('event', 'schedule') and p_principal_kind = 'person')
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200
    or p_outcome is null
    or p_outcome not in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
    or p_outputs is null
    or pg_catalog.jsonb_typeof(p_outputs) <> 'object'
    or pg_catalog.pg_column_size(p_outputs) > 65536 then
    return false;
  end if;

  update vortex_platform.flow_effect_ledger as ledger
  set state = 'completed',
      outcome = p_outcome,
      outputs = p_outputs,
      completed_at = pg_catalog.statement_timestamp()
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration
    and ledger.organization_id = p_organization_id
    and ledger.principal_kind = p_principal_kind
    and ledger.principal_id = p_principal_id
    and ledger.origin_kind = p_origin_kind
    and ledger.origin_id = p_origin_id
    and ledger.identity_id is not distinct from
      case when p_principal_kind = 'person' then p_principal_id else null end
    and ledger.state = 'started';

  return found;
end
$function$;
alter function vortex_platform.complete_flow_effect(
  uuid,uuid,text,uuid,text,uuid,text,text,text,jsonb
) owner to vortex_owner;

revoke all on function vortex_platform.complete_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.complete_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) to vortex_runtime;

comment on function vortex_platform.complete_flow_effect(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) is
  'Private effect completion for the exact run, principal, trigger origin, task path and iteration claim.';

create table vortex_access.flow_segment_rate_defaults (
  kind text primary key,
  account_limit integer not null check (account_limit > 0),
  organization_limit integer not null check (organization_limit >= account_limit)
);

insert into vortex_access.flow_segment_rate_defaults (kind, account_limit, organization_limit)
values ('change', 60, 6000), ('read', 600, 60000), ('mcp', 20, 2000);

create table vortex_access.flow_segment_rate_buckets (
  organization_id uuid not null,
  organization_account_id uuid,
  kind text not null references vortex_access.flow_segment_rate_defaults(kind),
  window_start timestamptz not null,
  used integer not null check (used >= 0),
  unique nulls not distinct (organization_id, organization_account_id, kind, window_start)
);

create index flow_segment_rate_buckets_prune
  on vortex_access.flow_segment_rate_buckets (organization_id, window_start);

revoke all on vortex_access.flow_segment_rate_defaults, vortex_access.flow_segment_rate_buckets
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

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

reset role;
set role vortex_record_adapter;

create or replace function vortex_record.flow_segment_receipt(
  p_command_id uuid, p_replay_only boolean
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  classified jsonb;
  stored_result jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_replay_only is null then
    raise exception using errcode = '22023', message = 'Flow segment command is invalid';
  end if;
  classified := vortex_record.claim_command_receipt_internal(
    'flow_segment', p_command_id, p_replay_only
  );
  if classified ->> 'status' <> 'completed' then
    return classified;
  end if;
  -- The classifier has checked the current organisation, tenant and actor before this read.
  select receipt.result into strict stored_result
  from vortex_record.command_receipts as receipt
  where receipt.command_id = p_command_id;
  return pg_catalog.jsonb_build_object('status', 'completed', 'result', stored_result);
end
$function$;

alter function vortex_record.flow_segment_receipt(uuid, boolean) owner to vortex_record_adapter;
revoke all on function vortex_record.flow_segment_receipt(uuid, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.flow_segment_receipt(uuid, boolean) to vortex_request, postgres;
comment on function vortex_record.flow_segment_receipt(uuid, boolean) is
  'Looks up or claims a flow segment command in the current human request scope.';

create or replace function vortex_record.complete_flow_segment_receipt(
  p_command_id uuid, p_result jsonb
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_result is null or pg_catalog.jsonb_typeof(p_result) <> 'object'
    or pg_catalog.pg_column_size(p_result) > 65536 then
    raise exception using errcode = '22023', message = 'Flow segment result is invalid';
  end if;
  update vortex_record.command_receipts as receipt
  set result = p_result
  where receipt.command_id = p_command_id
    and receipt.organization_id = (context_value ->> 'organizationId')::uuid
    and receipt.tenant_id = (context_value ->> 'tenantId')::uuid
    and receipt.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and receipt.command_kind = 'flow_segment'
    and receipt.result is null;
  if not found then
    raise exception using errcode = '40001', message = 'Flow segment receipt is not pending';
  end if;
end
$function$;

alter function vortex_record.complete_flow_segment_receipt(uuid, jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_flow_segment_receipt(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) to vortex_request, postgres;
comment on function vortex_record.complete_flow_segment_receipt(uuid, jsonb) is
  'Completes the current human request scope''s pending flow segment receipt.';

reset role;
