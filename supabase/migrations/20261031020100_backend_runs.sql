set role vortex_owner;

-- One run history for every back-end run: a Run on back end child and an after-save subscriber.
-- The unique key makes each request idempotent: a retried click or a re-delivered occurrence
-- returns the same row instead of running again.
create table vortex_platform.backend_runs (
  backend_run_id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null check (vortex_platform.is_non_nil_uuid(organization_id::text)),
  application_root_id uuid not null check (vortex_platform.is_non_nil_uuid(application_root_id::text)),
  flow_id uuid not null check (vortex_platform.is_non_nil_uuid(flow_id::text)),
  actor_id uuid not null check (vortex_platform.is_non_nil_uuid(actor_id::text)),
  origin_kind text not null check (origin_kind in ('backend_run', 'event')),
  source_key text not null check (pg_catalog.length(source_key) between 1 and 200),
  mode text not null check (mode in ('await', 'start')),
  inputs jsonb not null check (pg_catalog.jsonb_typeof(inputs) = 'object'),
  state text not null check (state in ('pending', 'running', 'succeeded', 'refused', 'failed')),
  outputs jsonb check (outputs is null or pg_catalog.jsonb_typeof(outputs) = 'object'),
  failure_code text check (failure_code is null or pg_catalog.length(failure_code) <= 100),
  claimed_until timestamptz,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  finished_at timestamptz,
  unique (organization_id, origin_kind, source_key, flow_id),
  check (state <> 'running' or claimed_until is not null)
);
create index backend_runs_waiting on vortex_platform.backend_runs (created_at)
  where state in ('pending', 'running');
alter table vortex_platform.backend_runs enable row level security;
revoke all on vortex_platform.backend_runs
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on table vortex_platform.backend_runs is
  'Run history of back-end runs (Run on back end children and after-save subscribers), one row per origin, source and flow. Reached only through the back-end run functions.';

create or replace function vortex_platform.resolve_backend_actor(
  p_organization_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  found_account record;
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_unknown');
  end if;

  select account.identity_id, account.state as account_state,
    organization.state as organization_state, tenant.state as tenant_state,
    identity.state as identity_state
  into found_account
  from vortex_identity.organization_accounts as account
  join vortex_identity.organizations as organization
    on organization.organization_id = account.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_identity.identity_projections as identity
    on identity.identity_id = account.identity_id
  where account.organization_account_id = p_actor_id
    and account.organization_id = p_organization_id;

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_unknown');
  end if;
  if found_account.account_state is distinct from 'active'
    or found_account.identity_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'actor_not_active');
  end if;
  if found_account.organization_state is distinct from 'active'
    or found_account.tenant_state is distinct from 'active' then
    return pg_catalog.jsonb_build_object('kind', 'refused', 'reason', 'organization_not_active');
  end if;
  return pg_catalog.jsonb_build_object('kind', 'available', 'identityId', found_account.identity_id);
end
$function$;
alter function vortex_platform.resolve_backend_actor(uuid, uuid) owner to vortex_owner;

revoke all on function vortex_platform.resolve_backend_actor(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.resolve_backend_actor(uuid, uuid) to vortex_runtime;

comment on function vortex_platform.resolve_backend_actor(uuid, uuid) is
  'Reads the identity behind one organisation account for a back-end run and refuses, with a named reason, an account, identity, organisation or tenant that is not active; the run never copies a session.';

create or replace function vortex_platform.request_backend_run(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_flow_id uuid,
  p_actor_id uuid,
  p_origin_kind text,
  p_source_key text,
  p_mode text,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  requested record;
begin
  if p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_flow_id is null or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_id::text)
    or p_origin_kind is null or p_origin_kind not in ('backend_run', 'event')
    or p_source_key is null or pg_catalog.length(p_source_key) not between 1 and 200
    or p_mode is null or p_mode not in ('await', 'start')
    or p_inputs is null or pg_catalog.jsonb_typeof(p_inputs) <> 'object'
    or pg_catalog.pg_column_size(p_inputs) > 16384 then
    raise exception using errcode = '22023', message = 'Back-end run request is invalid';
  end if;

  insert into vortex_platform.backend_runs (
    organization_id, application_root_id, flow_id, actor_id, origin_kind, source_key, mode,
    inputs, state
  ) values (
    p_organization_id, p_application_root_id, p_flow_id, p_actor_id, p_origin_kind, p_source_key,
    p_mode, p_inputs, 'pending'
  )
  on conflict (organization_id, origin_kind, source_key, flow_id) do nothing;

  select run.backend_run_id, run.state, run.outputs, run.failure_code, run.actor_id,
    run.application_root_id
  into requested
  from vortex_platform.backend_runs as run
  where run.organization_id = p_organization_id
    and run.origin_kind = p_origin_kind
    and run.source_key = p_source_key
    and run.flow_id = p_flow_id;

  -- A repeated key must repeat the same request, never silently reuse another run.
  if requested.actor_id is distinct from p_actor_id
    or requested.application_root_id is distinct from p_application_root_id then
    raise exception using errcode = '22023', message = 'Back-end run key is already used';
  end if;
  return pg_catalog.jsonb_build_object(
    'backendRunId', requested.backend_run_id,
    'state', requested.state,
    'outputs', requested.outputs,
    'failureCode', requested.failure_code
  );
end
$function$;
alter function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb) owner to vortex_owner;

revoke all on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb)
  to vortex_runtime;

comment on function vortex_platform.request_backend_run(uuid, uuid, uuid, uuid, text, text, text, jsonb) is
  'Records one pending back-end run once per origin, source key and flow; a repeat returns the same run and its state.';

create or replace function vortex_platform.claim_backend_run(p_backend_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed record;
begin
  if p_backend_run_id is null or not vortex_platform.is_non_nil_uuid(p_backend_run_id::text) then
    return null;
  end if;
  update vortex_platform.backend_runs as run
  set state = 'running',
    claimed_until = pg_catalog.statement_timestamp() + interval '2 minutes'
  where run.backend_run_id = p_backend_run_id
    and (
      run.state = 'pending'
      or (run.state = 'running' and run.claimed_until < pg_catalog.statement_timestamp())
    )
  returning run.backend_run_id, run.organization_id, run.application_root_id, run.flow_id,
    run.actor_id, run.origin_kind, run.source_key, run.inputs
  into claimed;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'backendRunId', claimed.backend_run_id,
    'organizationId', claimed.organization_id,
    'applicationRootId', claimed.application_root_id,
    'flowId', claimed.flow_id,
    'actorId', claimed.actor_id,
    'originKind', claimed.origin_kind,
    'sourceKey', claimed.source_key,
    'inputs', claimed.inputs
  );
end
$function$;
alter function vortex_platform.claim_backend_run(uuid) owner to vortex_owner;

revoke all on function vortex_platform.claim_backend_run(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.claim_backend_run(uuid) to vortex_runtime;

comment on function vortex_platform.claim_backend_run(uuid) is
  'Claims one pending (or abandoned) back-end run for two minutes so exactly one executor runs it; null when it is not claimable.';

create or replace function vortex_platform.finish_backend_run(
  p_backend_run_id uuid,
  p_state text,
  p_outputs jsonb,
  p_failure_code text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_backend_run_id is null or not vortex_platform.is_non_nil_uuid(p_backend_run_id::text)
    or p_state is null or p_state not in ('succeeded', 'refused', 'failed')
    or (p_outputs is not null and (
      pg_catalog.jsonb_typeof(p_outputs) <> 'object' or pg_catalog.pg_column_size(p_outputs) > 16384
    ))
    or (p_failure_code is not null and pg_catalog.length(p_failure_code) > 100) then
    raise exception using errcode = '22023', message = 'Back-end run result is invalid';
  end if;
  update vortex_platform.backend_runs as run
  set state = p_state,
    outputs = p_outputs,
    failure_code = p_failure_code,
    claimed_until = null,
    finished_at = pg_catalog.statement_timestamp()
  where run.backend_run_id = p_backend_run_id
    and run.state = 'running';
  return found;
end
$function$;
alter function vortex_platform.finish_backend_run(uuid, text, jsonb, text) owner to vortex_owner;

revoke all on function vortex_platform.finish_backend_run(uuid, text, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.finish_backend_run(uuid, text, jsonb, text)
  to vortex_runtime;

comment on function vortex_platform.finish_backend_run(uuid, text, jsonb, text) is
  'Records the final state, outputs and stable failure code of a running back-end run, once.';

create or replace function vortex_platform.list_pending_backend_runs(p_limit integer)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Back-end run limit is invalid';
  end if;
  return query
  select run.backend_run_id
  from vortex_platform.backend_runs as run
  where run.state = 'pending'
    or (run.state = 'running' and run.claimed_until < pg_catalog.statement_timestamp())
  order by run.created_at
  limit p_limit;
end
$function$;
alter function vortex_platform.list_pending_backend_runs(integer) owner to vortex_owner;

revoke all on function vortex_platform.list_pending_backend_runs(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.list_pending_backend_runs(integer) to vortex_runtime;

comment on function vortex_platform.list_pending_backend_runs(integer) is
  'Lists the oldest pending or abandoned back-end runs for the recovery tick.';

create or replace function vortex_platform.read_backend_run_history(
  p_application_root_id uuid,
  p_limit integer
)
returns table (
  backend_run_id uuid,
  flow_id uuid,
  origin_kind text,
  source_key text,
  state text,
  failure_code text,
  created_at timestamptz,
  finished_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
begin
  -- The caller must be a human whose organisation grants definition-draft management, the
  -- authority Studio uses to open an application; the organisation comes from that context.
  checked_context := vortex_definition.validated_builder_read_context_internal();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501', message = 'Back-end run history is unavailable';
  end if;
  if p_application_root_id is null
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Back-end run history request is invalid';
  end if;
  -- Outputs can hold record values, so the history never returns them.
  return query
  select run.backend_run_id, run.flow_id, run.origin_kind, run.source_key, run.state,
    run.failure_code, run.created_at, run.finished_at
  from vortex_platform.backend_runs as run
  where run.organization_id = (checked_context ->> 'organizationId')::uuid
    and run.application_root_id = p_application_root_id
  order by run.created_at desc
  limit p_limit;
end
$function$;
alter function vortex_platform.read_backend_run_history(uuid, integer) owner to vortex_owner;

revoke all on function vortex_platform.read_backend_run_history(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_platform.read_backend_run_history(uuid, integer)
  to vortex_request;

comment on function vortex_platform.read_backend_run_history(uuid, integer) is
  'Lists the newest back-end runs of one application (flow, origin, source, state, failure code, times) without their outputs; it requires definition-draft management in the own request context of the caller.';

reset role;
