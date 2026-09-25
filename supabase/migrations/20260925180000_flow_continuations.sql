-- Issue #579: the server flow orchestrator suspends a flow at a page-facing task and resumes it
-- from a server-stored continuation. A continuation is one row bound to its run, the verified
-- initiator, the organisation and the exact flow release; it expires and is single-use. The effect
-- ledger keys every protected effect by (run id, task path, iteration), so a replayed continuation
-- or a redelivered run never repeats an effect. Nothing here is reachable except through the four
-- functions below, which only the runtime role may execute.
create table vortex_module.flow_continuations (
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  run_id uuid not null check (vortex_context.is_non_nil_uuid(run_id::text)),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id)
    check (vortex_context.is_non_nil_uuid(organization_id::text)),
  identity_id uuid not null check (vortex_context.is_non_nil_uuid(identity_id::text)),
  flow_id uuid not null check (vortex_context.is_non_nil_uuid(flow_id::text)),
  release_key text not null check (pg_catalog.length(release_key) between 1 and 200),
  state jsonb not null check (pg_catalog.jsonb_typeof(state) = 'object'),
  elapsed_milliseconds integer not null check (elapsed_milliseconds between 0 and 3600000),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint flow_continuations_pk primary key (token_hash),
  constraint flow_continuations_expiry_after_creation check (expires_at > created_at)
);

create index flow_continuations_expiry_idx
  on vortex_module.flow_continuations (expires_at);

create table vortex_module.flow_effect_ledger (
  run_id uuid not null check (vortex_context.is_non_nil_uuid(run_id::text)),
  task_path text not null check (pg_catalog.length(task_path) between 1 and 1000),
  iteration text not null check (pg_catalog.length(iteration) between 1 and 200),
  organization_id uuid not null
    references vortex_identity.organizations (organization_id)
    check (vortex_context.is_non_nil_uuid(organization_id::text)),
  identity_id uuid not null check (vortex_context.is_non_nil_uuid(identity_id::text)),
  state text not null check (state in ('started', 'completed')),
  outcome text check (
    outcome in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
  ),
  outputs jsonb check (outputs is null or pg_catalog.jsonb_typeof(outputs) = 'object'),
  started_at timestamptz not null,
  completed_at timestamptz,
  constraint flow_effect_ledger_pk primary key (run_id, task_path, iteration),
  constraint flow_effect_ledger_completion_consistent check (
    (state = 'started' and outcome is null and outputs is null and completed_at is null)
    or (
      state = 'completed' and outcome is not null and outputs is not null
      and completed_at is not null
    )
  )
);

-- Both tables are private structural storage. Only the definer functions below reach them; no
-- runtime, request or Data API role reads or writes a row directly, so a continuation cannot be
-- forged, read across a person or organisation, or reused, and a protected effect cannot be
-- recorded twice.
alter table vortex_module.flow_continuations enable row level security;
alter table vortex_module.flow_effect_ledger enable row level security;
revoke all on table vortex_module.flow_continuations, vortex_module.flow_effect_ledger
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;

create or replace function vortex_module.issue_flow_continuation(
  p_token_hash text,
  p_run_id uuid,
  p_organization_id uuid,
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
    or not vortex_context.is_non_nil_uuid(p_run_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null
    or pg_catalog.length(p_release_key) not between 1 and 200
    or p_state is null
    or pg_catalog.jsonb_typeof(p_state) <> 'object'
    or pg_catalog.pg_column_size(p_state) > 262144
    or p_elapsed_milliseconds is null
    or p_elapsed_milliseconds not between 0 and 3600000
    or p_lifetime_seconds is null
    or p_lifetime_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Flow continuation is invalid';
  end if;

  -- Expired continuations are useless; remove a bounded few on every issue so the table never
  -- needs a separate sweeper.
  delete from vortex_module.flow_continuations as stale
  where stale.ctid in (
    select candidate.ctid
    from vortex_module.flow_continuations as candidate
    where candidate.expires_at < pg_catalog.statement_timestamp() - interval '1 day'
    limit 100
  );

  expiry := pg_catalog.statement_timestamp() + pg_catalog.make_interval(secs => p_lifetime_seconds);

  insert into vortex_module.flow_continuations (
    token_hash, run_id, organization_id, identity_id, flow_id, release_key, state,
    elapsed_milliseconds, created_at, expires_at
  ) values (
    p_token_hash, p_run_id, p_organization_id, p_identity_id, p_flow_id, p_release_key, p_state,
    p_elapsed_milliseconds, pg_catalog.statement_timestamp(), expiry
  );

  return expiry;
end
$function$;

revoke all on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) to vortex_runtime;

comment on function vortex_module.issue_flow_continuation(
  text, uuid, uuid, uuid, uuid, text, jsonb, integer, integer
) is
  'Private flow-continuation issue: stores the suspended state of one server-driven flow run bound to its run, initiator, organisation and exact flow release, expiring, under the hash of a server-generated token.';

create or replace function vortex_module.consume_flow_continuation(
  p_token_hash text,
  p_organization_id uuid,
  p_identity_id uuid,
  p_flow_id uuid,
  p_release_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  claimed record;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_release_key is null then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  -- One statement both checks every binding and marks the row used, so two concurrent resumes can
  -- never both succeed, and an unknown, expired, replayed, foreign or wrong-release token is one
  -- neutral result.
  update vortex_module.flow_continuations as continuation
  set consumed_at = pg_catalog.statement_timestamp()
  where continuation.token_hash = p_token_hash
    and continuation.organization_id = p_organization_id
    and continuation.identity_id = p_identity_id
    and continuation.flow_id = p_flow_id
    and continuation.release_key = p_release_key
    and continuation.consumed_at is null
    and continuation.expires_at > pg_catalog.statement_timestamp()
  returning continuation.run_id, continuation.state, continuation.elapsed_milliseconds
  into claimed;

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'runId', claimed.run_id,
    'state', claimed.state,
    'elapsedMilliseconds', claimed.elapsed_milliseconds
  );
end
$function$;

revoke all on function vortex_module.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_module.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) to vortex_runtime;

comment on function vortex_module.consume_flow_continuation(
  text, uuid, uuid, uuid, text
) is
  'Private flow-continuation consume: returns the stored run state once, and only to the exact initiator, organisation and flow release it was issued for while it has not expired; every other case is one neutral unavailable result.';

create or replace function vortex_module.begin_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
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
  if not vortex_context.is_non_nil_uuid(p_run_id::text)
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_task_path is null
    or pg_catalog.length(p_task_path) not between 1 and 1000
    or p_iteration is null
    or pg_catalog.length(p_iteration) not between 1 and 200 then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  insert into vortex_module.flow_effect_ledger (
    run_id, task_path, iteration, organization_id, identity_id, state, started_at
  ) values (
    p_run_id, p_task_path, p_iteration, p_organization_id, p_identity_id, 'started',
    pg_catalog.statement_timestamp()
  )
  on conflict (run_id, task_path, iteration) do nothing
  returning run_id into inserted_run_id;

  if inserted_run_id is not null then
    return pg_catalog.jsonb_build_object('kind', 'claimed');
  end if;

  select ledger.organization_id, ledger.identity_id, ledger.state, ledger.outcome, ledger.outputs
  into existing
  from vortex_module.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;

  if not found
    or existing.organization_id is distinct from p_organization_id
    or existing.identity_id is distinct from p_identity_id then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  -- A repeat never runs the effect again: a finished one replays its recorded safe outcome, and one
  -- that started but never recorded an outcome is uncertain and is reported as such.
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

revoke all on function vortex_module.begin_flow_effect(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_module.begin_flow_effect(
  uuid, uuid, uuid, text, text
) to vortex_runtime;

comment on function vortex_module.begin_flow_effect(
  uuid, uuid, uuid, text, text
) is
  'Private flow-effect claim: the first call for one run, task path and iteration claims the protected effect; every repeat replays the recorded safe outcome or reports it in progress, so a replayed flow can never repeat an effect.';

create or replace function vortex_module.complete_flow_effect(
  p_run_id uuid,
  p_organization_id uuid,
  p_identity_id uuid,
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
  if p_outcome is null
    or p_outcome not in (
      'completed', 'committed', 'background_pending', 'refused', 'conflict', 'validation',
      'uncertain', 'failed'
    )
    or p_outputs is null
    or pg_catalog.jsonb_typeof(p_outputs) <> 'object'
    or pg_catalog.pg_column_size(p_outputs) > 65536 then
    return false;
  end if;

  update vortex_module.flow_effect_ledger as ledger
  set state = 'completed',
      outcome = p_outcome,
      outputs = p_outputs,
      completed_at = pg_catalog.statement_timestamp()
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration
    and ledger.organization_id = p_organization_id
    and ledger.identity_id = p_identity_id
    and ledger.state = 'started';

  return found;
end
$function$;

revoke all on function vortex_module.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_module.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) to vortex_runtime;

comment on function vortex_module.complete_flow_effect(
  uuid, uuid, uuid, text, text, text, jsonb
) is
  'Private flow-effect completion: records the safe outcome of the one claimed protected effect of a run, task path and iteration so a repeat replays it.';

