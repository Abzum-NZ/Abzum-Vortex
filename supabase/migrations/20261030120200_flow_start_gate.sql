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
  if opened ->> 'outcome' <> 'opened' then
    -- System projection exact reads remain unavailable to the general exact-row API. Membership
    -- uses the same bounded projection reader with the already validated identity list.
    if opened ->> 'reasonCode' <> 'descriptor_invalid' then return opened; end if;
    opened := vortex_record.module_query_open_internal(
      p_module_root_id, p_query_id, p_expected_release_revision, p_input_values,
      p_requested_field_ids, p_requested_system_field_keys, p_filter, p_filterable_field_ids,
      p_sort, p_search, p_sortable_field_ids, p_searchable_field_ids,
      pg_catalog.cardinality(p_record_ids), 'forward', null);
    if opened ->> 'outcome' <> 'opened' then return opened; end if;
    if not (opened -> 'recordType' ? 'systemProjection') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
    end if;
    opened := pg_catalog.jsonb_set(opened, '{exactRecordIds}', pg_catalog.to_jsonb(p_record_ids));
  end if;
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

set role vortex_record_adapter;

create or replace function vortex_record.module_query_scan_internal(
  p_plan jsonb,
  p_member jsonb,
  p_prior_decision jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  -- A page ending at this candidate budget still returns its position for the next request.
  scan_limit constant integer := 500;
  member_kind text := p_member ->> 'kind';
  page_size integer := (p_plan ->> 'pageSize')::integer;
  direction text := p_plan ->> 'direction';
  record_type_id_value uuid := (p_plan ->> 'recordTypeId')::uuid;
  v_storage_contract_id uuid := (p_plan ->> 'storageContractId')::uuid;
  context_organization_id uuid := (p_plan ->> 'organizationId')::uuid;
  context_application_root_id uuid := (p_plan ->> 'applicationRootId')::uuid;
  preview_mode boolean := (p_plan ->> 'preview')::boolean;
  fields_by_id jsonb := p_plan -> 'fieldsById';
  storage_plan jsonb := p_plan -> 'storagePlan';
  requested_ids text[];
  system_field_keys text[];
  filter_ids text[];
  search_field_ids text[];
  user_search text := p_plan #>> '{searchPlan,search}';
  filter_condition jsonb := nullif(p_plan -> 'filterCondition', 'null'::jsonb);
  filter_exact boolean := (p_plan ->> 'filterExact')::boolean;
  filter_types jsonb := p_plan -> 'filterTypes';
  parameter_types jsonb := p_plan -> 'inputTypes';
  parameter_values jsonb := p_plan -> 'inputs';
  after_sort_key text[];
  after_record_id uuid := (p_plan ->> 'afterRecordId')::uuid;
  exact_record_ids uuid[];
  access_owner_account_id uuid := nullif(p_plan #>> '{storagePlan,access,ownerAccountId}', '')::uuid;
  access_owner_group_ids uuid[];
  access_shared_record_ids uuid[];
  segment_predicates text[];
  segment_sql text;
  scan_sql text;
  scan_record record;
  scan_cursor refcursor;
  cursor_position integer;
  lookahead_record record;
  lookahead_ids uuid[];
  read_row record;
  passes boolean;
  needs_refusal_check boolean;
  projection jsonb;
  readable_values jsonb;
  -- The one bounded system projection reader, when the plan chose it.
  projection_page_scan boolean := (p_plan ->> 'projectionPageScan')::boolean;
  projection_sort_key text := p_plan ->> 'projectionSortKey';
  projection_direction text := p_plan ->> 'projectionDirection';
  projection_predicate jsonb := p_plan -> 'projectionPredicate';
  projection_batch jsonb;
  projection_after jsonb := nullif(p_plan -> 'after', 'null'::jsonb);
  projection_batch_size integer;
  projection_candidate_count integer := 0;
  projection_reader_exhausted boolean := false;
  projection_batch_exhausted boolean := false;
  projection_last_record_id uuid;
  projection_last_sort_key text[];
  projection_failure text;
  -- The page's access facts, eligibility and validated record types stay those of this one scan.
  page_access_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_eligibility_checked boolean := false;
  validated_record_types jsonb;
  page_first_loaded jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[];
  decided_decisions jsonb[];
  decided_bounds jsonb[];
  decided_index integer;
  page_batching boolean := true;
  examined integer := 0;
  budget_exhausted boolean := false;
  every_bucket_more boolean := false;
  last_examined_sort_key text[];
  last_examined_record_id uuid;
  -- Page state by bucket: one bucket, except a board's shared first pages, where each readable row
  -- goes to the column its readable choice value names.
  bucket_count integer := case when p_member ->> 'kind' = 'choice'
    then pg_catalog.jsonb_array_length(p_member -> 'columns') else 1 end;
  bucket integer;
  bucket_rows jsonb[];
  bucket_capabilities jsonb[];
  bucket_counts integer[];
  bucket_more boolean[];
  bucket_first_keys jsonb[];
  bucket_first_ids uuid[];
  bucket_last_keys jsonb[];
  bucket_last_ids uuid[];
  page_capabilities jsonb;
  rows_value jsonb;
  next_value jsonb;
  opposite_value jsonb;
  pages jsonb := '[]'::jsonb;
  key_value jsonb;
  -- Membership of the closed mode value.
  choice_field_id text := p_member ->> 'choiceFieldId';
  choice_option_values text[];
  group_by_ids text[];
  group_selector_values jsonb := p_member -> 'groupValues';
  group_link_field_id text := p_member ->> 'linkFieldId';
  group_link_cache jsonb := coalesce(p_member -> 'linkCache', '{}'::jsonb);
  group_link_values jsonb[];
  group_candidate_values jsonb;
  member_matches boolean;
  tree_field_id text := p_member ->> 'fieldId';
  tree_parent_id uuid := (p_member ->> 'parentRecordId')::uuid;
  tree_item jsonb;
  tree_root_child_ids uuid[] := array[]::uuid[];
  tree_root_nonroot_ids uuid[];
  tree_root_readable_parent_ids uuid[];
begin
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into requested_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'requestedFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into system_field_keys
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'systemFieldKeys') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into filter_ids
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'filterFieldIds') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into search_field_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{searchPlan,fieldIds}') as item(value);
  select pg_catalog.array_agg(item.value #>> '{}' order by item.ordinality) into after_sort_key
  from pg_catalog.jsonb_array_elements(coalesce(nullif(p_plan -> 'afterSortKey', 'null'::jsonb), '[]'::jsonb))
    with ordinality as item(value, ordinality);
  if p_plan -> 'exactRecordIds' <> 'null'::jsonb then
    select pg_catalog.array_agg(item.value::uuid) into exact_record_ids
    from pg_catalog.jsonb_array_elements_text(p_plan -> 'exactRecordIds') as item(value);
  end if;
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_owner_group_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{storagePlan,access,ownerGroupIds}') as item(value);
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[]) into access_shared_record_ids
  from pg_catalog.jsonb_array_elements_text(p_plan #> '{storagePlan,access,sharedRecordIds}') as item(value);
  select pg_catalog.array_agg(item.value) into segment_predicates
  from pg_catalog.jsonb_array_elements_text(p_plan -> 'segmentPredicates') as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into choice_option_values
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'optionValues', '[]'::jsonb)) as item(value);
  select coalesce(pg_catalog.array_agg(item.value), array[]::text[]) into group_by_ids
  from pg_catalog.jsonb_array_elements_text(coalesce(p_member -> 'groupByFieldIds', '[]'::jsonb)) as item(value);
  -- A later scan of the same invocation (the next narrowed board column) reuses the first scan's
  -- page decision exactly as one scan reuses it for its next candidates.
  if p_prior_decision is not null then
    page_eligibility_checked := (p_prior_decision ->> 'checked')::boolean;
    page_first_loaded := nullif(p_prior_decision -> 'firstLoaded', 'null'::jsonb);
    page_declaration := nullif(p_prior_decision -> 'declaration', 'null'::jsonb);
    page_eligibility := nullif(p_prior_decision -> 'eligibility', 'null'::jsonb);
    page_shared := nullif(p_prior_decision -> 'shared', 'null'::jsonb);
    page_narrowed := (p_prior_decision ->> 'narrowed')::boolean;
    validated_record_types := nullif(p_prior_decision -> 'validatedRecordTypes', 'null'::jsonb);
  end if;
  bucket_rows := pg_catalog.array_fill('[]'::jsonb, array[bucket_count]);
  bucket_capabilities := bucket_rows;
  bucket_counts := pg_catalog.array_fill(0, array[bucket_count]);
  bucket_more := pg_catalog.array_fill(false, array[bucket_count]);
  bucket_first_keys := pg_catalog.array_fill('null'::jsonb, array[bucket_count]);
  bucket_first_ids := pg_catalog.array_fill(null::uuid, array[bucket_count]);
  bucket_last_keys := bucket_first_keys;
  bucket_last_ids := bucket_first_ids;
  if projection_page_scan then
    projection_batch_size := least(page_size, scan_limit);
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
      into projection_batch
      from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
        exact_record_ids, projection_sort_key, projection_direction, projection_after,
        projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
        record_id, revision, attribute_values, ordinality);
    exception when sqlstate '22023' then
      get stacked diagnostics projection_failure = message_text;
      if projection_failure in ('filter_field_not_declared', 'predicate_unsupported') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', projection_failure);
      end if;
      raise;
    end;
  end if;
  foreach segment_sql in array segment_predicates loop
  loop
  if projection_page_scan then
    projection_candidate_count := projection_candidate_count + pg_catalog.jsonb_array_length(projection_batch);
    projection_reader_exhausted := pg_catalog.jsonb_array_length(projection_batch) < projection_batch_size;
    if pg_catalog.jsonb_array_length(projection_batch) = 0 then
      exit;
    end if;
    projection_last_record_id := (projection_batch -> -1 ->> 'record_id')::uuid;
    projection_last_sort_key := array[projection_batch -> -1 -> 'attribute_values' ->> projection_sort_key];
    projection_after := pg_catalog.jsonb_build_object(
      'sortKey', pg_catalog.to_jsonb(projection_last_sort_key),
      'phase', case when projection_last_sort_key[1] is null then 'null' else 'value' end,
      'recordId', projection_last_record_id);
    projection_batch_exhausted := projection_candidate_count >= scan_limit;
  end if;
  scan_sql := pg_catalog.format(
    'select stored.record_id,
       array[%s]::text[] as sort_key,
       pg_catalog.jsonb_build_object(%s) as filter_values,
       pg_catalog.jsonb_build_object(%s) as system_values,
       %s as projection_row,
       %s as group_link_value
     from %s
     where stored.organisation_id = $1
       and stored.lifecycle_state = ''active''
       and ($12::uuid[] is null or stored.record_id = any ($12))
       and %s
       and (%s)
        and (case when (%s) then true else false end)
        and (%s)%s
        and (%s)
     order by %s
     limit $5',
    p_plan ->> 'sortKeySql',
    p_plan ->> 'filterValuesSql',
    p_plan ->> 'systemColumnsSql',
    p_plan ->> 'scanProjectionSql',
    coalesce(p_member ->> 'linkValueSql', 'null::jsonb'),
    p_plan ->> 'scanSourceSql',
    case when p_plan #>> '{storagePlan,storage,storageScope}' = 'application_contained'
      then 'stored.application_root_id = $2' else 'stored.application_root_id is null' end,
    p_plan #>> '{storagePlan,access,predicate}',
    p_plan ->> 'filterPredicate',
    coalesce(p_member ->> 'predicate', 'true'),
    segment_sql,
    p_plan ->> 'searchPrefilterSql',
    p_plan ->> 'orderBySql'
  );
  -- A validated type set stays local to this invocation and is passed only to
  -- the fixed record adapter's private evaluator.
  open scan_cursor scroll for execute scan_sql
    using context_organization_id, context_application_root_id, after_sort_key,
      after_record_id, scan_limit + 1, access_owner_account_id,
      access_owner_group_ids, access_shared_record_ids,
      p_plan -> 'filterParameters', coalesce(p_plan #> '{storagePlan,access,parameters}', '[]'::jsonb),
      projection_batch, exact_record_ids,
      p_member ->> 'columnValue', choice_option_values, group_selector_values, tree_parent_id,
      search_field_ids, user_search;
  cursor_position := 0;
  loop
    fetch scan_cursor into scan_record;
    exit when not found;
    cursor_position := cursor_position + 1;
    examined := examined + 1;
    if examined > scan_limit then
      budget_exhausted := true;
      exit;
    end if;
    -- The filter is evaluated on stored values first only to avoid reading
    -- rows it rejects; a row it admits is still read through the protected
    -- projection, and every filtered field must be readable there.
    -- A value the condition engine refuses decides nothing until the row is
    -- known to be readable, so an unreadable row can never cause a refusal.
    needs_refusal_check := false;
    -- Preparation has already validated the inputs. An exact SQL predicate
    -- has decided this condition over fields every candidate reader can see.
    if filter_condition is null or filter_exact then
      passes := true;
    else
      begin
        passes := vortex_access.evaluate_query_condition_internal(
          filter_condition, filter_types, scan_record.filter_values,
          parameter_types, parameter_values, false
        );
      exception when invalid_parameter_value then
        passes := true;
        needs_refusal_check := true;
      end;
    end if;
    if passes then
      page_access_loaded := null;
      if not page_eligibility_checked then
        -- Keep the reusable decision in this invocation; the request role cannot
        -- write it or pass it to the owner-only exact-record evaluator.
        page_eligibility_checked := true;
        -- The installation and its access plan are resolved once for the page;
        -- every exact record decision below consumes this local plan.
        page_shared := pg_catalog.jsonb_build_object(
          'installation', case when preview_mode
            then vortex_record.read_current_preview_installation_internal()
            else vortex_definition.read_current_active_installation() end);
        page_shared := page_shared || pg_catalog.jsonb_build_object('plan',
          vortex_record.resolve_installation_access_plan_internal(page_shared -> 'installation'));
        page_access_loaded := vortex_record.load_record_access_facts_with_plan_internal(
          record_type_id_value, 'read', scan_record.record_id, null,
          page_shared -> 'installation', page_shared -> 'plan', scan_record.projection_row
        );
        if page_access_loaded ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(page_access_loaded -> 'declaration') = 'object' then
          page_declaration := page_access_loaded -> 'declaration';
          if preview_mode then
            -- Owner authority and the exact storage binding were validated by
            -- preparation and the first loader in this invocation. Bounds are
            -- identical for every copied row of this record type.
            page_shared := page_shared || pg_catalog.jsonb_build_object(
              'previewBounds', vortex_record.preview_record_field_bounds_internal(
                record_type_id_value, v_storage_contract_id, p_plan -> 'recordType'));
          else
            page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
              page_declaration, vortex_access.validated_human_request_context(),
              pg_catalog.clock_timestamp()
            );
          end if;
          page_first_loaded := page_access_loaded;
          select page_shared || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
            page.narrowed
          into page_shared, page_narrowed
          from vortex_record.read_record_page_envelope_internal(record_type_id_value, page_first_loaded) as page;
        end if;
      end if;
      -- Decide this candidate and the page's next ones together in one set
      -- pass; the cursor returns to this row, so the scan order, budget and
      -- every later check stay those of the row-by-row walk.
      if page_batching and page_first_loaded is not null
        and not (scan_record.record_id = any (decided_ids)) then
        lookahead_ids := array[scan_record.record_id];
        while pg_catalog.cardinality(lookahead_ids) <= page_size loop
          fetch scan_cursor into lookahead_record;
          exit when not found;
          lookahead_ids := pg_catalog.array_append(lookahead_ids, lookahead_record.record_id);
        end loop;
        move absolute cursor_position from scan_cursor;
        select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
          pg_catalog.array_agg(decided.loaded), pg_catalog.array_agg(decided.decision),
          pg_catalog.array_agg(decided.bounds)
        into decided_ids, decided_loaded, decided_decisions, decided_bounds
        from vortex_record.read_record_page_decisions_internal(
          record_type_id_value, page_first_loaded, page_declaration, page_eligibility,
          lookahead_ids, page_shared -> 'envelope', page_narrowed
        ) as decided;
        page_batching := pg_catalog.cardinality(decided_ids) > 0;
      end if;
      -- The page's first record keeps the exact decision, which also validates
      -- the installation-wide facts every decided record shares.
      decided_index := case when page_access_loaded is null
        then pg_catalog.array_position(decided_ids, scan_record.record_id) end;
      select row_read.* into read_row
      from vortex_record.read_record_projection_with_validated_types_internal(
        record_type_id_value, scan_record.record_id, page_declaration, page_eligibility,
        validated_record_types, scan_record.projection_row,
        coalesce(decided_loaded[decided_index], page_access_loaded),
        decided_decisions[decided_index], decided_bounds[decided_index], page_shared
      ) as row_read;
      projection := read_row.projection;
      -- Only the exact evaluator validates record types for reuse.
      if validated_record_types is null and decided_index is null then
        validated_record_types := coalesce(
          read_row.read_facts -> 'validatedRecordTypes',
          case when projection ->> 'outcome' = 'allowed'
            then read_row.read_facts #> '{facts,recordTypes}' end
        );
      end if;
      if projection ->> 'outcome' = 'allowed' then
        readable_values := projection -> 'values';
        if member_kind = 'tree_roots' then
          -- Root membership uses exact batched parent decisions, never the access superset.
          if not (scan_record.record_id = any (tree_root_child_ids)) then
            tree_root_child_ids := array[scan_record.record_id];
            while pg_catalog.cardinality(tree_root_child_ids) <= page_size loop
              fetch scan_cursor into lookahead_record;
              exit when not found;
              tree_root_child_ids := pg_catalog.array_append(tree_root_child_ids, lookahead_record.record_id);
            end loop;
            move absolute cursor_position from scan_cursor;
            tree_item := vortex_record.read_query_tree_relatives_internal(
              true, tree_root_child_ids, (p_member ->> 'relationshipId')::uuid, context_organization_id,
              context_application_root_id, storage_plan, record_type_id_value, page_first_loaded,
              page_declaration, page_eligibility, page_shared, page_narrowed, validated_record_types,
              p_member -> 'filter');
            if tree_item ->> 'outcome' <> 'completed' then return tree_item; end if;
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_nonroot_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'recordIds') as item(value);
            select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
            into tree_root_readable_parent_ids
            from pg_catalog.jsonb_array_elements_text(tree_item -> 'readableParentRecordIds') as item(value);
          end if;
          if scan_record.record_id = any (tree_root_nonroot_ids) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A readable parent outside the filter/search still keeps its link value.
          -- Only an unreadable or absent parent is hidden, using the same exact batch decision.
          if not (scan_record.record_id = any (tree_root_readable_parent_ids)) then
            readable_values := pg_catalog.jsonb_set(readable_values, array[tree_field_id], 'null'::jsonb);
          end if;
        end if;
        -- Filters decide membership, so every referenced value must be readable.
        -- Sorts only decide order: the scan already drops unguaranteed sort keys
        -- and ends with record identity. A withheld published sort field must
        -- neither remove a readable row nor expose its value through ordering.
        if not exists (
          select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
          where not (readable_values ? referenced.id)
        ) and not exists (
          select 1 from pg_catalog.unnest(search_field_ids) as searched(id)
          where projection_page_scan and user_search is not null
            and not (readable_values ? searched.id)
        ) then
          if needs_refusal_check then
            return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
          end if;
          bucket := 1;
          if member_kind = 'choice' then
            -- A board row belongs to the column its readable choice value names, or to the
            -- unassigned column when it names no option. A column that already holds its page
            -- and the card after it does not read the row again.
            bucket := (
              select requested.ordinality::integer
              from pg_catalog.jsonb_array_elements(p_member -> 'columns') with ordinality
                as requested(value, ordinality)
              where case when (readable_values ? choice_field_id)
                  and pg_catalog.jsonb_typeof(readable_values -> choice_field_id) = 'string'
                  and (readable_values ->> choice_field_id) collate "C"
                    = any (choice_option_values)
                then requested.value ->> 'kind' = 'option'
                  and (requested.value ->> 'value') collate "C"
                    = (readable_values ->> choice_field_id) collate "C"
                else requested.value ->> 'kind' = 'unassigned' end
              limit 1
            );
            if bucket is null or bucket_more[bucket] then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'group' then
            member_matches := not exists (
              select 1 from pg_catalog.unnest(group_by_ids) as grouped(id)
              where not (readable_values ? grouped.id)
            );
            if member_matches and group_link_field_id is not null
              and group_selector_values -> group_link_field_id = '"not_available"'::jsonb then
              -- The group of unreadable targets: one protected title batch decides the targets of this
              -- row and the page's next candidates together; the cache holds each target once per call.
              if pg_catalog.jsonb_typeof(readable_values -> group_link_field_id) = 'object'
                and not (group_link_cache ? (readable_values -> group_link_field_id ->> 'recordId')) then
                group_link_values := array[readable_values -> group_link_field_id];
                while pg_catalog.cardinality(group_link_values) <= page_size loop
                  fetch scan_cursor into lookahead_record;
                  exit when not found;
                  group_link_values := pg_catalog.array_append(group_link_values, lookahead_record.group_link_value);
                end loop;
                move absolute cursor_position from scan_cursor;
                group_link_cache := vortex_record.group_link_unreadable_internal(
                  group_link_cache, group_link_values, fields_by_id -> group_link_field_id);
              end if;
              member_matches := coalesce(
                (group_link_cache ->> (readable_values -> group_link_field_id ->> 'recordId'))::boolean, false);
            elsif member_matches then
              select pg_catalog.jsonb_object_agg(grouped.id, vortex_record.grouping_value_internal(
                readable_values -> grouped.id, fields_by_id -> grouped.id ->> 'type', nullif(p_member -> 'dateBucket', 'null'::jsonb)
              ))
              into group_candidate_values
              from pg_catalog.unnest(group_by_ids) as grouped(id);
              member_matches := group_candidate_values = group_selector_values;
            end if;
            if not member_matches then
              last_examined_sort_key := scan_record.sort_key;
              last_examined_record_id := scan_record.record_id;
              continue;
            end if;
          elsif member_kind = 'tree_children' and not (
            pg_catalog.jsonb_typeof(readable_values -> tree_field_id) = 'object'
            and pg_catalog.lower(readable_values -> tree_field_id ->> 'recordId') = pg_catalog.lower(tree_parent_id::text)
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          -- A search term matches only through a searchable field this row exposes
          -- to the reader; a field the reader cannot see never decides a match, so
          -- a hidden value can neither satisfy a search nor be inferred from one.
          -- Only a text or number value, or the text members of a list value, is
          -- searched; a structured value's JSON keys and identifiers never match.
          if user_search is not null and not projection_page_scan
            and not vortex_record.query_search_matches_internal(
            readable_values, search_field_ids, user_search
          ) then
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = page_size then
            -- A full bucket with a matching row after it has more rows; the scan ends only when
            -- every bucket has.
            bucket_more[bucket] := true;
            if pg_catalog.array_position(bucket_more, false) is null then
              every_bucket_more := true;
              exit;
            end if;
            last_examined_sort_key := scan_record.sort_key;
            last_examined_record_id := scan_record.record_id;
            continue;
          end if;
          if bucket_counts[bucket] = 0 then
            bucket_first_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
            bucket_first_ids[bucket] := scan_record.record_id;
          end if;
          -- Keep the read facts and field bounds for one page-level capability
          -- decision after the readable page has been selected.
          bucket_capabilities[bucket] := bucket_capabilities[bucket] || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordId', scan_record.record_id, 'readBounds', read_row.read_bounds
            ) || case
              -- The page pass's compact record scope when it has one, also for
              -- the first record; its page-wide facts are the page envelope.
              when scan_record.record_id = any (decided_ids) then pg_catalog.jsonb_build_object('record',
                decided_loaded[pg_catalog.array_position(decided_ids, scan_record.record_id)])
              else pg_catalog.jsonb_build_object('readFacts', read_row.read_facts) end
          );
          bucket_rows[bucket] := bucket_rows[bucket] || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'recordId', scan_record.record_id,
            'revision', projection -> 'concurrencyNumber',
            'values', coalesce((
              select pg_catalog.jsonb_object_agg(requested.id, readable_values -> requested.id)
              from pg_catalog.unnest(requested_ids) as requested(id)
              where readable_values ? requested.id
            ), '{}'::jsonb)
          ) || case when pg_catalog.cardinality(system_field_keys) > 0
            then pg_catalog.jsonb_build_object('systemValues', scan_record.system_values)
            else '{}'::jsonb end);
          bucket_counts[bucket] := bucket_counts[bucket] + 1;
          bucket_last_keys[bucket] := pg_catalog.to_jsonb(scan_record.sort_key);
          bucket_last_ids[bucket] := scan_record.record_id;
        end if;
      end if;
    end if;
    last_examined_sort_key := scan_record.sort_key;
    last_examined_record_id := scan_record.record_id;
  end loop;
  close scan_cursor;
  exit when not projection_page_scan or every_bucket_more or projection_batch_exhausted
    or projection_reader_exhausted;
  projection_batch_size := least(page_size, scan_limit - projection_candidate_count);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(projected) order by projected.ordinality), '[]'::jsonb)
  into projection_batch
  from vortex_record.read_system_projection_rows_internal(v_storage_contract_id,
    exact_record_ids, projection_sort_key, projection_direction, projection_after,
    projection_batch_size, projection_predicate) with ordinality as projected(organization_id,
    record_id, revision, attribute_values, ordinality);
  end loop;
  exit when every_bucket_more or budget_exhausted;
  end loop;
  if projection_batch_exhausted and not bucket_more[1] then
    budget_exhausted := true;
    last_examined_sort_key := projection_last_sort_key;
    last_examined_record_id := projection_last_record_id;
  end if;
  -- Each bucket's page: its rows with their capabilities, in one pass over the page, and its own
  -- continuations, never another bucket's.
  for bucket in 1 .. bucket_count loop
    rows_value := bucket_rows[bucket];
    if bucket_counts[bucket] > 0 then
      page_capabilities := vortex_record.read_record_capabilities_page_internal(
        record_type_id_value, bucket_capabilities[bucket], page_shared -> 'envelope'
      );
      if pg_catalog.jsonb_typeof(page_capabilities) is distinct from 'array'
        or pg_catalog.jsonb_array_length(page_capabilities) <> bucket_counts[bucket] then
        raise exception using errcode = '55000', message = 'Page capabilities are unavailable';
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(page_capabilities) as item(value)
        where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      ) then
        raise exception using errcode = '55000', message = 'Record capabilities are unavailable';
      end if;
      select pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
          'capabilities', page_capabilities -> (item.ordinality::integer - 1)) order by item.ordinality)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    next_value := null;
    opposite_value := null;
    key_value := case when bucket_more[bucket] then bucket_last_keys[bucket]
      when budget_exhausted then pg_catalog.to_jsonb(last_examined_sort_key) end;
    if bucket_more[bucket] or budget_exhausted then
      next_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', key_value,
        'phase', case when pg_catalog.jsonb_array_length(key_value) > 0
          and key_value -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', case when bucket_more[bucket] then bucket_last_ids[bucket]
          else last_examined_record_id end
      );
    end if;
    if bucket_first_ids[bucket] is not null then
      opposite_value := pg_catalog.jsonb_build_object(
        'sort', p_plan -> 'cursorSort',
        'sortKey', bucket_first_keys[bucket],
        'phase', case when pg_catalog.jsonb_array_length(bucket_first_keys[bucket]) > 0
          and bucket_first_keys[bucket] -> 0 = 'null'::jsonb then 'null' else 'value' end,
        'recordId', bucket_first_ids[bucket]
      );
    end if;
    if direction = 'backward' and bucket_counts[bucket] > 1 then
      select pg_catalog.jsonb_agg(item.value order by item.ordinality desc)
      into rows_value
      from pg_catalog.jsonb_array_elements(rows_value) with ordinality as item(value, ordinality);
    end if;
    pages := pages || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'rows', rows_value, 'next', next_value, 'opposite', opposite_value));
  end loop;
  -- The scanned pages and the one page decision a later scan or tree read of this invocation reuses.
  return pg_catalog.jsonb_build_object(
    'outcome', 'scanned',
    'pages', pages,
    'decision', pg_catalog.jsonb_build_object(
      'checked', page_eligibility_checked, 'firstLoaded', page_first_loaded, 'declaration', page_declaration,
      'eligibility', page_eligibility, 'shared', page_shared, 'narrowed', page_narrowed,
      'validatedRecordTypes', validated_record_types)
  );
end
$function$;

alter function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.module_query_scan_internal(jsonb,jsonb,jsonb) is
  'Adapter-only candidate scan of every Module query page read: runs the planned scan of one organisation''s active records (application scope, access predicate, pushed filter, the mode''s stored-value predicate, keyset segment, search pre-predicate) within a 500-candidate budget, decides each candidate through the exact read_record projection with batched page decisions, then admits it only when every filtered field is readable, the closed membership value matches its readable values (all rows, a board column classified from its readable choice value, a generic group equal to its typed selector, the children of one parent, or the roots, decided from exact batched parent reads) and the search matches a readable searchable field. It returns one page per bucket with per-row capabilities and its own keyset continuations, never a hidden value.';

reset role;
