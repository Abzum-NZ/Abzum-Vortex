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
      1, 'segment', 'web', pg_catalog.jsonb_build_object('kind', v_kind, 'channel', vortex_platform.channel()), v_evaluated_at,
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

set role vortex_owner;

create or replace function vortex_platform.record_flow_segment_effect(
  p_run_id uuid, p_task_path text, p_iteration text, p_outcome text, p_outputs jsonb
)
returns void
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  identity_id_value uuid := (context_value ->> 'identityId')::uuid;
begin
  if p_run_id is null or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or p_task_path is null or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null or pg_catalog.length(p_iteration) not between 1 and 200
    or p_outcome is null or p_outcome not in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
    or p_outputs is null or pg_catalog.jsonb_typeof(p_outputs) <> 'object'
    or pg_catalog.pg_column_size(p_outputs) > 65536 then
    raise exception using errcode = '22023', message = 'Flow segment effect is invalid';
  end if;
  insert into vortex_platform.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id, principal_kind, principal_id,
    origin_kind, origin_id, state, outcome, outputs, started_at, completed_at
  ) values (
    p_run_id, p_task_path, p_iteration, (context_value ->> 'organizationId')::uuid,
    identity_id_value, 'person', identity_id_value, 'person', identity_id_value,
    'completed', p_outcome, p_outputs, pg_catalog.statement_timestamp(), pg_catalog.statement_timestamp()
  );
end
$function$;

alter function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb) owner to vortex_owner;
revoke all on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb)
  to vortex_request, postgres;
comment on function vortex_platform.record_flow_segment_effect(uuid, text, text, text, jsonb) is
  'Records a completed human flow effect within the current admitted segment transaction.';

reset role;
set role vortex_record_adapter;

create or replace function vortex_record.run_module_query_members(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_requested_field_ids uuid[],
  p_requested_system_field_keys text[],
  p_filter jsonb,
  p_filterable_field_ids uuid[],
  p_sort jsonb,
  p_search text,
  p_sortable_field_ids uuid[],
  p_searchable_field_ids uuid[],
  p_record_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  opened jsonb;
  bound jsonb;
  plan jsonb;
  scanned jsonb;
  member_ids jsonb;
begin
  if p_record_ids is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  opened := vortex_record.module_query_open_internal(
    p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
    p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
    p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids,
    pg_catalog.cardinality(p_record_ids), 'forward', p_record_ids);
  if opened ->> 'outcome' <> 'opened' then return opened; end if;
  -- An aggregate without groups has no row gestures. Grouped shapes retain their underlying rows.
  if pg_catalog.jsonb_typeof(opened #> '{query,aggregates}') = 'array'
    and pg_catalog.jsonb_array_length(opened #> '{query,aggregates}') > 0
    and pg_catalog.jsonb_array_length(coalesce(opened #> '{query,groupByFieldIds}', '[]'::jsonb)) = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  bound := vortex_record.module_query_bind_internal(opened);
  if bound ->> 'outcome' <> 'bound' then return bound; end if;
  plan := vortex_record.module_query_scan_plan_internal(
    bound,
    case when pg_catalog.jsonb_array_length(bound -> 'sort') > 0 then bound -> 'sort' else bound #> '{query,sort}' end,
    pg_catalog.jsonb_array_length(bound -> 'sort') > 0, true, true, null);
  if plan ->> 'outcome' <> 'planned' then return plan; end if;
  scanned := vortex_record.module_query_scan_internal(plan, '{"kind": "all"}'::jsonb, null);
  if scanned ->> 'outcome' <> 'scanned' then return scanned; end if;
  select coalesce(pg_catalog.jsonb_agg(item.value -> 'recordId'), '[]'::jsonb)
  into member_ids
  from pg_catalog.jsonb_array_elements(scanned #> '{pages,0,rows}') as item(value);
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'recordIds', member_ids);
end
$function$;

alter function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) owner to vortex_record_adapter;
revoke all on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[])
  to vortex_request;
comment on function vortex_record.run_module_query_members(uuid,uuid,bigint,jsonb,uuid[],text[],jsonb,uuid[],jsonb,text,uuid[],uuid[],uuid[]) is
  'Returns only identities of supplied records admitted by the installed query filter and current read authority, ignoring grouping while refusing aggregate-only shapes.';

reset role;

set role vortex_owner;

create table vortex_access.flow_run_evidence (
  run_id uuid primary key,
  organization_id uuid not null,
  identity_id uuid not null,
  application_root_id uuid not null,
  flow_id uuid not null,
  binding_id uuid not null,
  state text not null check (state in ('started', 'pending', 'succeeded', 'refused', 'failed', 'closed')),
  pending_command_id uuid,
  completion_command_id uuid,
  expires_at timestamptz not null,
  check ((state = 'pending') = (pending_command_id is not null)),
  check ((state = 'closed') = (completion_command_id is not null))
);

create index flow_run_evidence_expiry on vortex_access.flow_run_evidence (expires_at);
revoke all on vortex_access.flow_run_evidence
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
create or replace function vortex_access.flow_run_evidence(
  p_action text, p_run_id uuid, p_flow_id uuid, p_binding_id uuid, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  v_organization_id uuid := (context_value ->> 'organizationId')::uuid;
  v_identity_id uuid := (context_value ->> 'identityId')::uuid;
  v_application_root_id uuid := (context_value ->> 'applicationRootId')::uuid;
  v_run_id uuid;
  held record;
begin
  if p_action is null or p_action not in ('start', 'lock', 'pending', 'succeeded', 'refused', 'failed', 'close')
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or not vortex_platform.is_non_nil_uuid(p_binding_id::text)
    or not vortex_platform.is_non_nil_uuid(v_application_root_id::text)
    or (p_action <> 'start' and not vortex_platform.is_non_nil_uuid(p_run_id::text))
    or (p_action in ('pending', 'close') and not vortex_platform.is_non_nil_uuid(p_command_id::text)) then
    raise exception using errcode = '22023', message = 'Flow run evidence is invalid';
  end if;
  if p_action = 'start' then
    delete from vortex_access.flow_run_evidence as stale
    where stale.ctid in (
      select candidate.ctid from vortex_access.flow_run_evidence as candidate
      where candidate.expires_at < pg_catalog.statement_timestamp() - interval '1 day'
      limit 100
    );
    v_run_id := pg_catalog.gen_random_uuid();
    insert into vortex_access.flow_run_evidence (
      run_id, organization_id, identity_id, application_root_id, flow_id, binding_id,
      state, expires_at
    ) values (
      v_run_id, v_organization_id, v_identity_id, v_application_root_id, p_flow_id, p_binding_id,
      'started', pg_catalog.statement_timestamp() + interval '15 minutes'
    );
    return pg_catalog.jsonb_build_object('runId', v_run_id, 'state', 'started');
  end if;
  select evidence.state, evidence.pending_command_id, evidence.completion_command_id into held
  from vortex_access.flow_run_evidence as evidence
  where evidence.run_id = p_run_id
    and evidence.organization_id = v_organization_id
    and evidence.identity_id = v_identity_id
    and evidence.application_root_id = v_application_root_id
    and evidence.flow_id = p_flow_id
    and evidence.binding_id = p_binding_id
    and evidence.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('state', 'unavailable'); end if;
  if p_action = 'lock' then
    return pg_catalog.jsonb_build_object(
      'state', held.state, 'pendingCommandId', held.pending_command_id,
      'completionCommandId', held.completion_command_id
    );
  end if;
  if held.state = 'closed' then
    return pg_catalog.jsonb_build_object('state', case
      when p_action = 'close' and held.completion_command_id = p_command_id then 'closed'
      else 'unavailable' end);
  end if;
  if held.state = 'pending' and held.pending_command_id is distinct from p_command_id then
    return pg_catalog.jsonb_build_object('state', 'unavailable');
  end if;
  if p_action = 'close' and held.state not in ('started', 'succeeded') then
    return pg_catalog.jsonb_build_object('state', 'unavailable');
  end if;
  update vortex_access.flow_run_evidence as evidence
  set state = case when p_action = 'close' then 'closed' else p_action end,
      pending_command_id = case when p_action = 'pending' then p_command_id else null end,
      completion_command_id = case when p_action = 'close' then p_command_id else null end,
      expires_at = pg_catalog.statement_timestamp() + interval '15 minutes'
  where evidence.run_id = p_run_id;
  return pg_catalog.jsonb_build_object('state', case when p_action = 'close' then 'closed' else p_action end);
end
$function$;

alter function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid) owner to vortex_owner;
revoke all on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid)
  to vortex_request, postgres;
comment on function vortex_access.flow_run_evidence(text, uuid, uuid, uuid, uuid) is
  'Maintains expiring flow completion evidence under the verified caller and application scope.';

alter table vortex_platform.flow_continuations
  add column application_root_id uuid,
  add column consumed_command_id uuid,
  add column replay_payload text,
  add column child_token_hash text;

-- Existing continuations do not identify an application and cannot be safely rebound.
update vortex_platform.flow_continuations
set consumed_at = coalesce(consumed_at, pg_catalog.statement_timestamp()),
    expires_at = greatest(created_at + interval '1 microsecond',
      least(expires_at, pg_catalog.statement_timestamp()));
do $block$
begin
  raise notice 'FLOW_CONTINUATION_APPLICATION_UNAVAILABLE: pre-migration continuations were expired';
end
$block$;
alter table vortex_platform.flow_continuations
  add constraint flow_continuations_application_binding_check
  check (application_root_id is not null or consumed_at is not null);

drop function vortex_platform.issue_flow_continuation(text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer);
drop function vortex_platform.consume_flow_continuation(text, uuid, uuid, uuid, text);
create or replace function vortex_platform.issue_flow_continuation(
  p_token_hash text,
  p_run_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_identity_id uuid,
  p_flow_id uuid,
  p_release_key text,
  p_state jsonb,
  p_elapsed_milliseconds integer,
  p_lifetime_seconds integer
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null
    or pg_catalog.length(p_release_key) not between 1 and 200
    or p_state is null
    or pg_catalog.jsonb_typeof(p_state) <> 'object'
    -- One bounded release, 500 independently retained historical roles and 256 KiB of flow state.
    or pg_catalog.pg_column_size(p_state) > 100663296
    or p_elapsed_milliseconds is null
    or p_elapsed_milliseconds not between 0 and 3600000
    or p_lifetime_seconds is null
    or p_lifetime_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Flow continuation is invalid';
  end if;

  -- Expired continuations are useless; remove a bounded few on every issue so the table never
  -- needs a separate sweeper.
  delete from vortex_platform.flow_continuations as stale
  where stale.ctid in (
    select candidate.ctid
    from vortex_platform.flow_continuations as candidate
    where candidate.expires_at < pg_catalog.statement_timestamp() - interval '1 day'
    limit 100
  );

  expiry := pg_catalog.statement_timestamp() + pg_catalog.make_interval(secs => p_lifetime_seconds);

  insert into vortex_platform.flow_continuations (
    token_hash, run_id, organization_id, application_root_id, identity_id, flow_id, release_key, state,
    elapsed_milliseconds, created_at, expires_at
  ) values (
    p_token_hash, p_run_id, p_organization_id, p_application_root_id, p_identity_id, p_flow_id, p_release_key, p_state,
    p_elapsed_milliseconds, pg_catalog.statement_timestamp(), expiry
  );

  return expiry;
end
$function$;

alter function vortex_platform.issue_flow_continuation(text,uuid,uuid,uuid,uuid,uuid,text,jsonb,integer,integer) owner to vortex_owner;

revoke all on function vortex_platform.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) to vortex_runtime;

comment on function vortex_platform.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) is
  'Private flow-continuation issue: stores the suspended state of one server-driven flow run bound to its run, initiator, organisation and exact flow release, expiring, under the hash of a server-generated token.';


create or replace function vortex_platform.peek_flow_continuation(
  p_token_hash text, p_organization_id uuid, p_application_root_id uuid,
  p_identity_id uuid, p_flow_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  held record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;
  select continuation.run_id, continuation.state, continuation.elapsed_milliseconds, continuation.release_key into held
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = p_organization_id
    and continuation.application_root_id = p_application_root_id
    and continuation.identity_id = p_identity_id
    and continuation.flow_id = p_flow_id
    and continuation.expires_at > pg_catalog.statement_timestamp();
  if not found then return pg_catalog.jsonb_build_object('kind', 'unavailable'); end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'available', 'runId', held.run_id, 'state', held.state,
    'elapsedMilliseconds', held.elapsed_milliseconds, 'releaseKey', held.release_key
  );
end
$function$;

alter function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid) owner to vortex_owner;
revoke all on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid)
  to vortex_runtime, postgres;
comment on function vortex_platform.peek_flow_continuation(text, uuid, uuid, uuid, uuid) is
  'Reads the caller-bound continuation for path selection without consuming it.';

create or replace function vortex_platform.admit_flow_continuation(
  p_token_hash text, p_run_id uuid, p_flow_id uuid, p_release_key text, p_command_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  held record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or not vortex_platform.is_non_nil_uuid(p_run_id::text)
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_release_key is null then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  select continuation.consumed_at, continuation.consumed_command_id, continuation.replay_payload,
    continuation.child_token_hash into held
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.run_id = p_run_id
    and continuation.organization_id = (context_value ->> 'organizationId')::uuid
    and continuation.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and continuation.identity_id = (context_value ->> 'identityId')::uuid
    and continuation.flow_id = p_flow_id
    and continuation.release_key = p_release_key
    and continuation.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('status', 'unavailable'); end if;
  if held.consumed_at is not null then
    return case when held.consumed_command_id = p_command_id
      then pg_catalog.jsonb_build_object(
        'status', 'replay', 'payload', held.replay_payload,
        'expiresAt', (select child.expires_at from vortex_platform.flow_continuations as child
          where child.token_hash = held.child_token_hash)
      )
      else pg_catalog.jsonb_build_object('status', 'already_answered') end;
  end if;
  update vortex_platform.flow_continuations as continuation
  set consumed_at = pg_catalog.statement_timestamp(), consumed_command_id = p_command_id
  where continuation.token_hash = p_token_hash;
  return pg_catalog.jsonb_build_object('status', 'admitted');
end
$function$;

alter function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid) owner to vortex_owner;
revoke all on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid)
  to vortex_request, postgres;
comment on function vortex_platform.admit_flow_continuation(text, uuid, uuid, text, uuid) is
  'Consumes an admitted continuation once and permits replay by the same command under current human scope.';

create or replace function vortex_platform.complete_flow_continuation(
  p_token_hash text, p_command_id uuid, p_child_token_hash text, p_child_state jsonb,
  p_elapsed_milliseconds integer, p_lifetime_seconds integer, p_replay_payload text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  parent record;
  expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_child_token_hash is null or p_child_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or p_replay_payload is null or pg_catalog.length(p_replay_payload) not between 1 and 1000000 then
    raise exception using errcode = '22023', message = 'Flow continuation replay is invalid';
  end if;
  select continuation.* into parent
  from vortex_platform.flow_continuations as continuation
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = (context_value ->> 'organizationId')::uuid
    and continuation.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and continuation.identity_id = (context_value ->> 'identityId')::uuid
    and continuation.consumed_command_id = p_command_id
    and continuation.consumed_at is not null
    and continuation.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then return pg_catalog.jsonb_build_object('status', 'unavailable'); end if;
  if parent.replay_payload is not null then
    return pg_catalog.jsonb_build_object(
      'status', 'replay', 'payload', parent.replay_payload,
      'expiresAt', (select child.expires_at from vortex_platform.flow_continuations as child
        where child.token_hash = parent.child_token_hash)
    );
  end if;
  expiry := vortex_platform.issue_flow_continuation(
    p_child_token_hash, parent.run_id, parent.organization_id, parent.application_root_id, parent.identity_id,
    parent.flow_id, parent.release_key, p_child_state, p_elapsed_milliseconds, p_lifetime_seconds
  );
  update vortex_platform.flow_continuations as continuation
  set replay_payload = p_replay_payload, child_token_hash = p_child_token_hash
  where continuation.token_hash = p_token_hash;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'expiresAt', expiry);
end
$function$;

alter function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text) owner to vortex_owner;
revoke all on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text)
  to vortex_request, postgres;
comment on function vortex_platform.complete_flow_continuation(text, uuid, text, jsonb, integer, integer, text) is
  'Issues one child continuation and records its sealed reply atomically on the consumed parent.';

reset role;
