begin;

-- Keep the private reader behind a non-login function owner; runtime receives no table access.
grant select (
  intent_id, organization_id, application_root_id, application_release_revision,
  application_release_version, flow_owner_kind, flow_owner_root_id,
  flow_release_revision, flow_release_version, flow_release_fingerprint,
  flow_id, source_kind, source_id, trigger_type, trigger_id,
  inputs, trigger_values, caller, status, accepted_at
) on table vortex_workflow.flow_start_intents to vortex_workflow_owner;
create policy flow_start_intents_vortex_workflow_owner_select
  on vortex_workflow.flow_start_intents
  for select to vortex_workflow_owner using (true);

alter table vortex_workflow.flow_effect_ledger
  drop constraint flow_effect_ledger_identity_id_check,
  alter column identity_id drop not null;
alter table vortex_workflow.flow_effect_ledger
  add constraint flow_effect_ledger_identity_id_valid check (
    identity_id is null or vortex_context.is_non_nil_uuid(identity_id::text)
  ),
  add column principal_kind text,
  add column principal_id uuid,
  add column origin_kind text,
  add column origin_id uuid,
  add constraint flow_effect_ledger_actor_origin_valid check (
    (
      principal_kind is null and principal_id is null
      and origin_kind is null and origin_id is null
      and identity_id is not null
    )
    or (
      principal_kind is not null
      and principal_kind = 'person'
      and origin_kind is not null
      and principal_id is not null
      and principal_id = identity_id
      and vortex_context.is_non_nil_uuid(principal_id::text)
      and origin_kind = 'person'
      and origin_id is not null
      and origin_id = principal_id
      and vortex_context.is_non_nil_uuid(origin_id::text)
    )
    or (
      principal_kind is not null
      and principal_kind in ('specified_account', 'system')
      and origin_kind is not null
      and principal_id is not null
      and vortex_context.is_non_nil_uuid(principal_id::text)
      and identity_id is null
      and origin_kind in ('event', 'schedule')
      and origin_id is not null
      and vortex_context.is_non_nil_uuid(origin_id::text)
    )
  );

-- Add only the columns the private effect functions need; existing callback functions keep their person API.
grant select (principal_kind, principal_id, origin_kind, origin_id)
  on table vortex_workflow.flow_effect_ledger to vortex_workflow_owner;
grant insert (principal_kind, principal_id, origin_kind, origin_id)
  on table vortex_workflow.flow_effect_ledger to vortex_workflow_owner;

set local role vortex_workflow_owner;
create or replace function vortex_workflow.begin_flow_effect_with_origin(
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
  if p_run_id is null or not vortex_context.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'specified_account', 'system')
    or p_principal_id is null
    or not vortex_context.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_context.is_non_nil_uuid(p_origin_id::text)
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

  insert into vortex_workflow.flow_effect_ledger (
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
  from vortex_workflow.flow_effect_ledger as ledger
  where ledger.run_id = p_run_id
    and ledger.task_path = p_task_path
    and ledger.iteration = p_iteration;

  if not found
    or existing.organization_id is distinct from p_organization_id
    or not (
      (
        existing.principal_kind = p_principal_kind
        and existing.principal_id = p_principal_id
        and existing.origin_kind = p_origin_kind
        and existing.origin_id = p_origin_id
      )
      or (
        existing.principal_kind is null
        and existing.principal_id is null
        and existing.origin_kind is null
        and existing.origin_id is null
        and p_principal_kind = 'person'
        and existing.identity_id = p_principal_id
        and p_origin_kind = 'person'
        and p_origin_id = p_principal_id
      )
    ) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  -- The legacy person match preserves safe replay of continuations created before this migration.
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

alter function vortex_workflow.begin_flow_effect_with_origin(uuid,uuid,text,uuid,text,uuid,text,text)
  owner to vortex_workflow_owner;

revoke all on function vortex_workflow.begin_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.begin_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text
) to vortex_runtime;

comment on function vortex_workflow.begin_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text
) is
  'Private effect claim bound to a verified person or execution principal and trigger origin; the run, task path and iteration remain duplicate-safe, including compatible legacy person rows.';

create or replace function vortex_workflow.complete_flow_effect_with_origin(
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
  if p_run_id is null or not vortex_context.is_non_nil_uuid(p_run_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_principal_kind is null
    or p_principal_kind not in ('person', 'specified_account', 'system')
    or p_principal_id is null
    or not vortex_context.is_non_nil_uuid(p_principal_id::text)
    or p_origin_kind is null
    or p_origin_kind not in ('person', 'event', 'schedule')
    or p_origin_id is null
    or not vortex_context.is_non_nil_uuid(p_origin_id::text)
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

  update vortex_workflow.flow_effect_ledger as ledger
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

alter function vortex_workflow.complete_flow_effect_with_origin(
  uuid,uuid,text,uuid,text,uuid,text,text,text,jsonb
) owner to vortex_workflow_owner;

revoke all on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) to vortex_runtime;

comment on function vortex_workflow.complete_flow_effect_with_origin(
  uuid, uuid, text, uuid, text, uuid, text, text, text, jsonb
) is
  'Private effect completion for the exact run, principal, trigger origin, task path and iteration claim.';

create or replace function vortex_workflow.read_committed_flow_start_intent(
  p_intent_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored record;
begin
  if not vortex_context.is_non_nil_uuid(p_intent_id::text) then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select
    intent.intent_id,
    intent.organization_id,
    intent.application_root_id,
    intent.application_release_revision,
    intent.application_release_version,
    intent.flow_owner_kind,
    intent.flow_owner_root_id,
    intent.flow_release_revision,
    intent.flow_release_version,
    intent.flow_release_fingerprint,
    intent.flow_id,
    intent.source_kind,
    intent.source_id,
    intent.trigger_type,
    intent.trigger_id,
    intent.inputs,
    intent.trigger_values,
    intent.caller,
    intent.status,
    intent.accepted_at
  into stored
  from vortex_workflow.flow_start_intents as intent
  where intent.intent_id = p_intent_id
    and intent.status = 'pending';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  if stored.source_kind <> 'event'
    or stored.trigger_type <> 'Event'
    or stored.caller ->> 'kind' is distinct from 'event'
    or stored.caller ->> 'correlationId' is null
    or not vortex_context.is_non_nil_uuid(stored.caller ->> 'correlationId') then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'intent', pg_catalog.jsonb_build_object(
      'intentId', stored.intent_id,
      'organizationId', stored.organization_id,
      'applicationRootId', stored.application_root_id,
      'applicationReleaseRevision', stored.application_release_revision,
      'applicationReleaseVersion', stored.application_release_version,
      'flowRelease', pg_catalog.jsonb_build_object(
        'ownerKind', stored.flow_owner_kind,
        'rootId', stored.flow_owner_root_id,
        'revision', stored.flow_release_revision,
        'version', stored.flow_release_version,
        'fingerprint', stored.flow_release_fingerprint
      ),
      'flowId', stored.flow_id,
      'origin', 'event',
      'originId', stored.source_id,
      'trigger', pg_catalog.jsonb_build_object(
        'type', 'Event',
        'id', stored.trigger_id
      ),
      'inputs', stored.inputs,
      'triggerValues', stored.trigger_values,
      'correlationId', stored.caller ->> 'correlationId',
      'acceptedAt', stored.accepted_at
    )
  );
end
$function$;

alter function vortex_workflow.read_committed_flow_start_intent(uuid)
  owner to vortex_workflow_owner;

revoke all on function vortex_workflow.read_committed_flow_start_intent(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_workflow.read_committed_flow_start_intent(uuid)
  to vortex_runtime;

comment on function vortex_workflow.read_committed_flow_start_intent(uuid) is
  'Runtime-only read of one committed pending Event start intent, including its exact accepted release and persisted origin; absent, action-based and malformed starts return one neutral unavailable result.';
reset role;
commit;
