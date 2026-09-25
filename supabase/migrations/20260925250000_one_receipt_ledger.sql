-- #1060: one command receipt ledger for record saves, named actions and
-- lifecycle commands.
--
-- Record saves and ownership transfers (`save_command_receipts`), named actions
-- (`named_action_command_receipts`) and protected delete/restore
-- (`record_lifecycle_command_receipts`) each kept their own replay ledger and
-- repeated the same claim, replay and complete code. This migration replaces
-- them with one table, `vortex_record.command_receipts`, keyed by the request
-- actor's scope, the command kind and the command identity, and one helper set:
--
--   * `claim_command_receipt_internal` claims a command identity as pending, or
--     classifies the existing receipt as identity_conflict, pending or completed
--     with its stored result (and only reads when asked for a replay-only view);
--   * `complete_command_receipt_internal` completes the pending receipt;
--   * `release_command_receipt_internal` releases a pending receipt that is refused
--     before any change;
--   * `lock_command_receipt_internal` returns the locked receipt to a finalizing
--     writer;
--   * `command_receipt_exists_internal` is the read-only existence check that
--     preparation reads use.
--
-- The actor scope always comes from the verified request context. The command
-- kind is part of the key, so a save, a named action and a lifecycle command
-- may still carry the same command identity independently (a soft-deleting
-- named action runs its delete under the action's own identity). Replay and
-- refusal results are unchanged. Existing receipts are copied first, so a retry
-- of a command completed before this migration still replays, and the lifecycle
-- effect journal is re-pointed at the new table. The three old tables are then
-- dropped: no function, canonical file or runtime code still reads them.
--
-- Every function that read or wrote an old table is re-created here in full,
-- with an unchanged signature, owner, grants, security and search_path. Each
-- statement is identical to the canonical file
-- supabase/schemas/vortex_record/<function>.sql changed in this commit.
-- `record_lifecycle_receipt_outcome_internal` is superseded by the claim helper
-- and dropped.
--
-- The two ownership-transfer writers also lose their update of
-- `vortex_record.record_deadline_due_metadata`: #1067 (20260925090000) dropped
-- that table but left the update in both live bodies, so every transfer failed
-- at run time.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create table vortex_record.command_receipts (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_kind text not null,
  command_id uuid not null,
  operation text not null,
  command_fingerprint text not null,
  record_type_id uuid not null,
  record_id uuid,
  command_identity jsonb not null default '{}'::jsonb,
  expected_concurrency_number bigint,
  recovery_policy_revision bigint,
  activity_id uuid,
  occurrence_id uuid,
  state text not null,
  concurrency_number bigint,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  constraint command_receipts_pk primary key (
    organization_id, application_root_id, actor_organization_account_id,
    command_kind, command_id
  ),
  constraint command_receipts_kind_valid check (
    command_kind in ('record_save', 'named_action', 'record_lifecycle')
  ),
  constraint command_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint command_receipts_state_valid check (
    state in ('pending', 'completed')
  ),
  constraint command_receipts_identity_valid check (
    pg_catalog.jsonb_typeof(command_identity) = 'object'
  ),
  -- A record save or ownership transfer names its record only when it completes.
  constraint command_receipts_save_valid check (
    command_kind <> 'record_save' or (
      operation in ('create', 'update', 'transfer_ownership')
      and command_identity = '{}'::jsonb
      and expected_concurrency_number is null
      and recovery_policy_revision is null
      and activity_id is null
      and occurrence_id is null
      and (
        (state = 'pending' and record_id is null and concurrency_number is null
          and completed_at is null)
        or
        (state = 'completed' and record_id is not null
          and concurrency_number between 1 and 9007199254740991
          and completed_at is not null)
      )
    )
  ),
  -- A named action names its subject Record and its exact action release.
  constraint command_receipts_named_action_valid check (
    command_kind <> 'named_action' or (
      operation = 'named_action'
      and record_id is not null
      and command_identity ?& array['actionOwnerKind', 'actionOwnerId', 'actionReleaseRevision', 'actionId']
      and command_identity ->> 'actionOwnerKind' in ('application', 'module')
      and (command_identity ->> 'actionReleaseRevision')::bigint between 1 and 9007199254740991
      and expected_concurrency_number is null
      and recovery_policy_revision is null
      and activity_id is null
      and occurrence_id is null
      and (
        (state = 'pending' and concurrency_number is null and completed_at is null)
        or
        (state = 'completed'
          and concurrency_number between 1 and 9007199254740991
          and completed_at is not null)
      )
    )
  ),
  -- A lifecycle command names its Record, revision and Activity when it starts.
  -- Only a delete appends a standard Event; a restore for a target with no
  -- stored policy is pending without a revision and is then refused.
  constraint command_receipts_lifecycle_valid check (
    command_kind <> 'record_lifecycle' or (
      operation in ('delete', 'restore')
      and record_id is not null
      and command_identity = '{}'::jsonb
      and expected_concurrency_number between 1 and 9007199254740990
      and activity_id is not null
      and activity_id <> '00000000-0000-0000-0000-000000000000'::uuid
      and (
        (operation = 'delete' and recovery_policy_revision is null
          and occurrence_id is not null
          and occurrence_id <> '00000000-0000-0000-0000-000000000000'::uuid)
        or
        (operation = 'restore' and occurrence_id is null
          and (
            recovery_policy_revision between 1 and 9007199254740991
            or (recovery_policy_revision is null and state = 'pending')
          ))
      )
      and (
        (state = 'pending' and concurrency_number is null and completed_at is null)
        or
        (state = 'completed'
          and concurrency_number > expected_concurrency_number
          and concurrency_number <= 9007199254740991
          and completed_at is not null)
      )
    )
  )
);

alter table vortex_record.command_receipts enable row level security;
alter table vortex_record.command_receipts force row level security;
create policy command_receipts_adapter
  on vortex_record.command_receipts to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.command_receipts owner to vortex_record_adapter;
revoke all on table vortex_record.command_receipts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on table vortex_record.command_receipts is
  'The one scoped idempotency receipt per human command, for record saves and ownership transfers, named actions and protected lifecycle commands. A command identity is scoped by organisation, Application, actor and command kind.';

-- Existing receipts move unchanged, so a retry of a command that completed before
-- this migration still replays.
insert into vortex_record.command_receipts (
  organization_id, application_root_id, actor_organization_account_id,
  command_kind, command_id, operation, command_fingerprint, record_type_id,
  record_id, command_identity, state, concurrency_number, created_at, completed_at
)
select
  stored.organization_id, stored.application_root_id,
  stored.actor_organization_account_id, 'record_save', stored.command_id,
  stored.operation, stored.command_fingerprint, stored.record_type_id,
  stored.record_id, '{}'::jsonb, stored.state, stored.concurrency_number,
  stored.created_at, stored.completed_at
from vortex_record.save_command_receipts as stored;

insert into vortex_record.command_receipts (
  organization_id, application_root_id, actor_organization_account_id,
  command_kind, command_id, operation, command_fingerprint, record_type_id,
  record_id, command_identity, state, concurrency_number, created_at, completed_at
)
select
  stored.organization_id, stored.application_root_id,
  stored.actor_organization_account_id, 'named_action', stored.command_id,
  'named_action', stored.command_fingerprint, stored.record_type_id,
  stored.record_id,
  pg_catalog.jsonb_build_object(
    'actionOwnerKind', stored.action_owner_kind,
    'actionOwnerId', stored.action_owner_id,
    'actionReleaseRevision', stored.action_release_revision,
    'actionId', stored.action_id
  ),
  stored.state, stored.concurrency_number, stored.created_at, stored.completed_at
from vortex_record.named_action_command_receipts as stored;

insert into vortex_record.command_receipts (
  organization_id, application_root_id, actor_organization_account_id,
  command_kind, command_id, operation, command_fingerprint, record_type_id,
  record_id, command_identity, expected_concurrency_number, recovery_policy_revision,
  activity_id, occurrence_id, state, concurrency_number, created_at, completed_at
)
select
  stored.organization_id, stored.application_root_id,
  stored.actor_organization_account_id, 'record_lifecycle', stored.command_id,
  stored.operation, stored.command_fingerprint, stored.record_type_id,
  stored.record_id, '{}'::jsonb, stored.expected_concurrency_number,
  stored.recovery_policy_revision, stored.activity_id, stored.occurrence_id,
  stored.state, stored.completed_concurrency_number, stored.created_at,
  stored.completed_at
from vortex_record.record_lifecycle_command_receipts as stored;

-- The lifecycle effect journal follows its command to the one receipt table.
alter table vortex_record.record_lifecycle_command_effects
  add column command_kind text not null default 'record_lifecycle',
  add constraint record_lifecycle_command_effects_kind_valid check (
    command_kind = 'record_lifecycle'
  ),
  drop constraint record_lifecycle_command_effects_receipt_fk,
  add constraint record_lifecycle_command_effects_receipt_fk foreign key (
    organization_id, application_root_id, actor_organization_account_id,
    command_kind, command_id
  ) references vortex_record.command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_kind, command_id
  ) on delete cascade;

create or replace function vortex_record.command_receipt_exists_internal(
  p_command_kind text,
  p_command_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_kind = p_command_kind
      and receipt.command_id = p_command_id
  );
end
$function$;

revoke all on function vortex_record.command_receipt_exists_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.command_receipt_exists_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.command_receipt_exists_internal(
  text, uuid
) is
  'True when the request actor already holds a receipt for this command identity and kind, whatever its state or content. Preparation reads use it to leave replay and identity-conflict classification to the receipt owner.';

create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_operation text,
  p_fingerprint text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_identity jsonb,
  p_details jsonb,
  p_replay_only boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  identity_value jsonb := coalesce(p_identity, '{}'::jsonb);
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;

  -- The command identity is claimed as pending. A claim that finds an existing
  -- receipt locks it and classifies it; a replay-only read classifies without
  -- inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      organization_id, application_root_id, actor_organization_account_id,
      command_kind, command_id, operation, command_fingerprint, record_type_id,
      record_id, command_identity, expected_concurrency_number, recovery_policy_revision,
      activity_id, occurrence_id, state
    ) values (
      organization_id_value, application_root_id_value, actor_id_value,
      p_command_kind, p_command_id, p_operation, p_fingerprint, p_record_type_id,
      p_record_id, identity_value,
      (p_details ->> 'expectedConcurrencyNumber')::bigint,
      (p_details ->> 'recoveryPolicyRevision')::bigint,
      (p_details ->> 'activityId')::uuid,
      (p_details ->> 'occurrenceId')::uuid,
      'pending'
    )
    on conflict do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    for update;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  if not found
    or receipt.command_fingerprint is distinct from p_fingerprint
    or receipt.operation is distinct from p_operation
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.command_identity is distinct from identity_value
    or (p_record_id is not null and receipt.record_id is distinct from p_record_id) then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.state is distinct from 'completed' then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'recordId', receipt.record_id,
    'concurrencyNumber', receipt.concurrency_number
  );
end
$function$;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the request actor''s command identity as pending, or classifies the existing receipt as identity_conflict, pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';

create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_record_id uuid,
  p_concurrency_number bigint,
  p_stale_message text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  update vortex_record.command_receipts as stored
  set state = 'completed',
    record_id = coalesce(p_record_id, stored.record_id),
    concurrency_number = p_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) is
  'Completes the request actor''s pending command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';

create or replace function vortex_record.release_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  delete from vortex_record.command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
end
$function$;

revoke all on function vortex_record.release_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.release_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.release_command_receipt_internal(
  text, uuid
) is
  'Releases the request actor''s pending command receipt when its command is refused before any change, so the identity can be used again.';

create or replace function vortex_record.lock_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
)
returns vortex_record.command_receipts
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
  for update;
  return receipt;
end
$function$;

revoke all on function vortex_record.lock_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.lock_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.lock_command_receipt_internal(
  text, uuid
) is
  'Locks and returns the request actor''s command receipt, or a row of nulls when there is none. Finalizing writers read the state the preflight stored through it.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  module_content jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  fingerprint_value text;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, p_operation, fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', 'pending',
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  installation := vortex_module.read_current_active_installation();

  select release.compilation_output #> '{canonical,content}'
  into strict module_content
  from vortex_definition.releases as release
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint;

  select release.compilation_output #> '{canonical,content}'
  into strict application_content
  from vortex_definition.releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed base Record save.';

create or replace function vortex_record.save_base_record(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;

  command_fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, p_operation, command_fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', 'pending',
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' = 'refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || p_final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        -- #858: take this target row lock here, before the writer loop below
        -- takes any edge identity, so a later iteration never locks a target
        -- row after an earlier iteration already holds an edge identity.
        perform vortex_record.lock_relationship_target_row_internal(
          target_record_type_id, target_record_id, organization_id_value
        );
        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, p_final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if p_final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      mutation := vortex_record.change_record(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else p_final_values end
  ) as key;

  activity_time := vortex_record.append_base_save_activity_internal(
    p_activity_id, p_operation, saved_record_id,
    changed_field_ids, 'completed'
  );

  event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
  event_payload := case when p_operation = 'create'
    then pg_catalog.jsonb_build_object('kind', 'created')
    else pg_catalog.jsonb_build_object(
      'kind', 'changed',
      'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
    ) end;
  event_result := vortex_event.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', event_kind,
        'recordTypeId', p_record_type_id
      ),
      'payload', event_payload
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record save Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, saved_record_id, saved_concurrency_number,
    'Record save receipt is stale'
  );

  projection := vortex_record.read_record(p_record_type_id, saved_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved Record projection is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.save_base_record(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
revoke execute on function vortex_record.save_base_record(uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid)
from vortex_runtime;

comment on function vortex_record.save_base_record(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid
) is
  'The one fixed base human Record save: rechecks authority and atomically writes Record, Activity, Event/queue and receipt.';

create or replace function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  access_loaded jsonb;
  access_decision jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_operation not in ('create', 'update')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'update' and p_selected_group_id is not null)
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  -- Receipt resolution remains owned by prepare_base_record_save. Merely seeing
  -- an existing identity here avoids dependency reads or locks on replays and
  -- changed-input duplicates.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(root_type -> 'fields') field(value)
    where field.value ->> 'type' = 'total'
  ) and pg_catalog.jsonb_array_length(root_type -> 'relationships') = 0 then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  -- Authorize the old source without a row lock before discovering or locking
  -- any concrete dependency. A denied update is deferred to the base prepare,
  -- which owns the existing content-free refusal Activity.
  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, null
    );
    if access_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'defer');
    end if;
    if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', context_organization_id,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  before_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if before_closure is null then return pg_catalog.jsonb_build_object('outcome', 'defer'); end if;

  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;

  after_closure := vortex_record.discover_relationship_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
  );
  if after_closure is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- A concurrent exact or changed-input duplicate may have completed while
  -- this transaction waited for the source/parent locks. Let the existing
  -- receipt owner distinguish replay from command-identity conflict.
  if vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if p_operation = 'update' and (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  if p_operation = 'update' then
    access_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if access_loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_decision := vortex_access.evaluate_organization_record_access_internal(
      access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
    );
    if access_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
    access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);
  end if;

  -- Materialize only the declared aggregate sources for each locked affected
  -- record. The initial source's proposed move replaces its old membership in
  -- this transaction-visible snapshot.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then return pg_catalog.jsonb_build_object('outcome', 'refused'); end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then proposed_target := p_submitted_values -> source_field_id; end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_relationship_total_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private Stage 2B preflight: discovers old/proposed concrete total closure, locks it canonically, re-reads it, and returns only declared evaluator inputs.';

create or replace function vortex_record.save_base_record_with_relationship_totals(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  preparation_value jsonb;
  reduced_final_values jsonb;
  context_value jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  expected_parents jsonb;
  supplied_parents jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Receipt identity remains authoritative for replay and changed-input
  -- duplicate classification. A completed command must reach that owner even
  -- if a caller supplies no longer-current relationship mutations.
  if not vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    -- The writer repeats the protected preparation itself.  Closure identity,
    -- revisions and the complete generated-field set therefore never depend
    -- on caller-controlled transaction state or a replayable preparation token.
    preparation_value := vortex_record.prepare_relationship_total_save(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,
      p_activity_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      catalogue := vortex_record.relationship_total_catalogue_internal();
      if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
        closure_value := vortex_record.discover_relationship_total_closure_internal(
          catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
        );
        select item.value into root_type
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') =
          pg_catalog.lower(p_record_type_id::text);
        select item.value into root_snapshot
        from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if root_type is null or root_snapshot is null then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
        for relationship_value, target_type in
          select item.value, target.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
            on vortex_record.relationship_declares_target_internal(
              item.value, (target.value ->> 'recordTypeId')::uuid
            )
          where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
          order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
        loop
          relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
          old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
          proposed_relationship_target := old_relationship_target;
          if p_submitted_values ? relationship_field_id then
            proposed_relationship_target := p_submitted_values -> relationship_field_id;
          end if;
          if not (
            (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
              pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
            or
            (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
              pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
          ) then
            continue;
          end if;
          for total_field in
            select field.value
            from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
            where field.value ->> 'type' = 'total'
              and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                pg_catalog.lower(relationship_value ->> 'relationshipId')
          loop
            if p_submitted_values ? relationship_field_id and
              p_submitted_values -> relationship_field_id is distinct from
                coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
              contributes_to_total := true;
              exit;
            end if;
            dependency_contract := vortex_record.total_dependency_contract_internal(
              catalogue -> 'recordTypes',
              pg_catalog.jsonb_build_array(relationship_value),
              (target_type ->> 'recordTypeId')::uuid, total_field
            );
            for dependency_field_id in
              select item.value
              from pg_catalog.jsonb_array_elements_text(
                dependency_contract -> 'sourceFieldIds'
              ) item(value)
            loop
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
            end loop;
            exit when contributes_to_total;
          end loop;
          exit when contributes_to_total;
        end loop;
        if contributes_to_total then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;
    if preparation_value ->> 'outcome' <> 'prepared' then
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
        preparation_value := null;
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    else
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.lower(field.value ->> 'fieldId')
              order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
            )
            from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
            where field.value ->> 'type' in ('total', 'calculation')
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into expected_parents
      from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
      where item.value ->> 'recordKey' <> 'root';
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
            from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into supplied_parents
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;
  result_value := vortex_record.save_base_record(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' <> 'saved' or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;
  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023', message = 'Relationship total parent mutation is incomplete';
    end if;
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;
  return result_value;
end
$function$;

revoke all on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
to vortex_runtime;
comment on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) is
  'Existing protected base save composed with revision-checked generated parent totals, Activity and standard Events in the same transaction.';

create or replace function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  projection jsonb;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, 'named_action', fingerprint_value,
    p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
      'actionOwnerKind', p_action_owner_kind,
      'actionOwnerId', p_action_owner_id,
      'actionReleaseRevision', p_action_release_revision,
      'actionId', p_action_id
    ), '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- #571: a deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
          p_expected_concurrency_number
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'effects') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) item(value)
      where item.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'soft_delete_subject', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id,
    case when p_preview then null else p_expected_concurrency_number end
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
      loaded -> 'facts' -> 'recordTypes', p_record_type_id,
      bounds -> 'readableFieldIds'
    )
  );
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- #578: the owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.prepare_named_action_set_announce_internal(
  boolean, uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, uuid
) is
  'Private named-action preparation: replays or refuses by command receipt, then returns the facts, permission decision and bounds of the exact installed action, writing nothing.';

create or replace function vortex_record.save_named_action_set_announce(
  p_command_id uuid, p_record_type_id uuid, p_record_id uuid,
  p_expected_concurrency_number bigint, p_submitted_values jsonb,
  p_final_values jsonb, p_activity_id uuid, p_standard_occurrence_id uuid,
  p_declared_occurrence_ids jsonb, p_action_owner_kind text,
  p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  result_value jsonb;
  event_result jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  set_field_ids jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) effect(value)
      where effect.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'soft_delete_subject', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'unsupported');
  end if;
  select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
  into set_field_ids
  from (
    select distinct pg_catalog.lower(effect.value ->> 'fieldId') as field_id
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'effects') effect(value)
    where effect.value ->> 'kind' = 'set_field'
  ) fields;
  if pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_declared_occurrence_ids) is distinct from 'array'
    or set_field_ids is distinct from coalesce((
      select pg_catalog.jsonb_agg(key order by key collate "C")
      from pg_catalog.jsonb_object_keys(p_submitted_values) key
    ), '[]'::jsonb)
    or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  -- A create-only action whose created record moves one of the subject's own
  -- totals still has to write the subject. The fixed writer already accepts a
  -- final-value map of generated fields with an empty submitted-field set
  -- (`20260912011556:1149-1192`), so the only change here is reaching it when
  -- `p_final_values` is non-empty rather than only when a `set_field` exists.
  if pg_catalog.jsonb_array_length(set_field_ids) > 0 or p_final_values <> '{}'::jsonb then
    result_value := vortex_record.save_named_action_set_fields_internal(
      p_command_id, 'update', p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_final_values, null,
      p_activity_id, p_standard_occurrence_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id, p_inputs
    );
    if result_value ->> 'outcome' <> 'saved'
      or coalesce((result_value ->> 'replayed')::boolean, false) then
      return result_value;
    end if;
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', p_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_array_length(event_result) <>
      pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    return result_value;
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, 'named_action', fingerprint_value,
    p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
      'actionOwnerKind', p_action_owner_kind,
      'actionOwnerId', p_action_owner_id,
      'actionReleaseRevision', p_action_release_revision,
      'actionId', p_action_id
    ), '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    return vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
  end if;
  perform vortex_record.append_named_action_activity_internal(
    p_activity_id, p_record_id, array[]::uuid[], 'completed'
  );
  event_result := vortex_record.append_declared_named_action_occurrences_internal(
    (action_context ->> 'storageContractId')::uuid, p_record_id,
    action_context -> 'eventDescriptors', p_declared_occurrence_ids,
    loaded -> 'fieldValues'
  );
  if pg_catalog.jsonb_array_length(event_result) <>
    pg_catalog.jsonb_array_length(p_declared_occurrence_ids) then
    raise exception using errcode = '55000',
      message = 'Named action declared Event append failed';
  end if;
  perform vortex_record.complete_command_receipt_internal(
    'named_action', p_command_id, null, p_expected_concurrency_number,
    'Named action receipt is stale'
  );
  result_value := vortex_record.project_named_action_record_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id
  );
  if result_value ->> 'outcome' <> 'completed' then
    raise exception using errcode = '55000',
      message = 'Named action Record projection is unavailable';
  end if;
  return result_value || pg_catalog.jsonb_build_object('replayed', false);
end
$function$;

revoke all on function vortex_record.save_named_action_set_announce(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, text, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.save_named_action_set_announce(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, text, uuid, bigint, uuid, jsonb
) is
  'Terminal named-action writer for the announce-only shape: claims the command receipt and writes its Activity and declared Events in one transaction.';

create or replace function vortex_record.transfer_record_ownership(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  projection jsonb;
  event_result jsonb;
  updated_concurrency_number bigint;
  changed_rows integer;
begin
  if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is null
    or p_target_kind not in ('organization_account', 'group')
    or p_target_id is null or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  command_fingerprint_value := vortex_record.ownership_transfer_command_fingerprint_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_target_kind, p_target_id, 'public', null
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, 'transfer_ownership', command_fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- A replay reprojects from current access and intentionally never returns
    -- owner metadata (including the prior target).
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId', 'replayed', true
    );
  end if;
  -- The closed transfer authority is its own exact record permission decision;
  -- it is evaluated under the record lock, while owner columns remain
  -- unavailable to the ordinary update writer.
  -- Public transfer is active-installation-only.  It deliberately never calls
  -- the retained/detached reader, so a detached record cannot leak its current
  -- revision through the ordinary conflict response.
  begin
    installation := vortex_module.read_current_active_installation();
  exception
    when no_data_found then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
  end;
  loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number, installation
  );
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into record_type_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or record_type_fact is null
    or record_fact ->> 'lifecycleState' <> 'active' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  ownership_mode := record_type_fact ->> 'ownershipMode';
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(
      p_activity_id, organization_id_value, 'refused'
    );
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
  end if;
  if ownership_mode = 'organization_account' then
    previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
  elsif ownership_mode = 'group' then
    previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
  else
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if (ownership_mode = 'organization_account' and p_target_kind <> 'organization_account')
    or (ownership_mode = 'group' and p_target_kind <> 'group')
    or previous_owner_id is null or previous_owner_id = p_target_id
    or not vortex_access.lock_active_record_ownership_target_internal(p_target_kind, p_target_id) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'owner_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id = $3,
       owner_group_id = $4, concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $5
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $6 returning stored.concurrency_number',
    loaded ->> 'table'
  ) into updated_concurrency_number using organization_id_value, p_record_id,
    case when p_target_kind = 'organization_account' then p_target_id else null end,
    case when p_target_kind = 'group' then p_target_id else null end,
    actor_id_value, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
  end if;
  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (record_type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
  event_result := vortex_event.append_record_occurrences(
    (record_type_fact ->> 'storageContractId')::uuid,
    p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
      ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
  end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id, updated_concurrency_number,
    'Record ownership transfer receipt is stale'
  );
  -- This is deliberately an undisclosed result: an authorised transfer may
  -- remove the operator's read path.  A post-write projection would turn that
  -- valid committed mutation into a rollback.  Exact replay still applies
  -- current disclosure separately above.
  return pg_catalog.jsonb_build_object(
    'outcome', 'transferred', 'recordId', p_record_id,
    'concurrencyNumber', updated_concurrency_number,
    'correlationId', context_value -> 'correlationId', 'replayed', false
  );
end
$function$;

revoke all on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.transfer_record_ownership(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid
) is
  'Fixed server-only single-record ownership transfer: current explicit transfer authority, compatible active target and expected revision, atomically with Activity, reassigned Event/queue and receipt.';

create or replace function vortex_record.transfer_record_ownership_for_offboarding_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_source_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb; organization_id_value uuid; application_root_id_value uuid;
  actor_id_value uuid; fingerprint text; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  fingerprint := vortex_record.ownership_transfer_command_fingerprint_internal(
    p_command_id,p_record_type_id,p_record_id,p_expected_concurrency_number,p_target_kind,p_target_id,
    'offboarding',p_source_organization_account_id);
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, 'transfer_ownership', fingerprint,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or type_fact is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' <> 'soft_deleted')
    or type_fact ->> 'ownershipMode' <> 'organization_account'
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  -- Retained rows are never restored.  The unchanged complete Access
  -- evaluator sees only this locked target as active in an in-memory facts
  -- view, preserving every existing transfer route and condition.
  evaluation_facts := loaded -> 'facts';
  if record_fact ->> 'lifecycleState' = 'soft_deleted' then
    evaluation_facts := evaluation_facts || pg_catalog.jsonb_build_object(
      'records',
      (
        select pg_catalog.jsonb_agg(
          case
            when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
              then pg_catalog.jsonb_set(
                item.value, '{lifecycleState}', '"active"'::jsonb, false
              )
            else item.value
          end
          order by item.ordinal
        )
        from pg_catalog.jsonb_array_elements(evaluation_facts -> 'records')
          with ordinality as item(value, ordinal)
      )
    );
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, evaluation_facts
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,organization_id_value,'refused');
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.concurrency_number',
    loaded ->> 'table') into updated_concurrency using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,p_record_id,'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_event.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_event.append_record_occurrences(
      (type_fact ->> 'storageContractId')::uuid, p_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId',p_occurrence_id,
        'descriptor',pg_catalog.jsonb_build_object(
          'kind','standard','eventKind','reassigned','recordTypeId',p_record_type_id
        ),
        'payload',pg_catalog.jsonb_build_object('kind','reassigned')
      ))
    );
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, p_record_id, updated_concurrency,
    'Offboarding ownership transfer receipt is stale'
  );
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',p_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

create or replace function vortex_record.save_named_action_set_fields_internal(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation is distinct from 'update'
    or p_action_owner_kind is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision is null
    or p_action_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;

  command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'named_action', p_command_id, 'named_action', command_fingerprint_value,
    p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
      'actionOwnerKind', p_action_owner_kind,
      'actionOwnerId', p_action_owner_id,
      'actionReleaseRevision', p_action_release_revision,
      'actionId', p_action_id
    ), '{}'::jsonb, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', 'pending',
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if p_operation = 'update' then
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', meta -> 'declaration' -> 'recordBinding'
      )
    );
    if decision ->> 'outcome' = 'refused' then
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || p_final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        -- #858: take this target row lock here, before the writer loop below
        -- takes any edge identity, so a later iteration never locks a target
        -- row after an earlier iteration already holds an edge identity.
        perform vortex_record.lock_relationship_target_row_internal(
          target_record_type_id, target_record_id, organization_id_value
        );
        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, p_final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if p_final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      mutation := vortex_record.change_record_by_named_action_internal(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids,
        p_action_owner_kind, p_action_owner_id, p_action_release_revision, p_action_id
      );
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal('named_action', p_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else p_final_values end
  ) as key;

  activity_time := vortex_record.append_named_action_activity_internal(
    p_activity_id, saved_record_id, changed_field_ids, 'completed'
  );

  event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
  event_payload := case when p_operation = 'create'
    then pg_catalog.jsonb_build_object('kind', 'created')
    else pg_catalog.jsonb_build_object(
      'kind', 'changed',
      'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
    ) end;
  event_result := vortex_event.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', event_kind,
        'recordTypeId', p_record_type_id
      ),
      'payload', event_payload
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Record save Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'named_action', p_command_id, saved_record_id, saved_concurrency_number,
    'Record save receipt is stale'
  );

  projection := vortex_record.project_named_action_record_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, saved_record_id
  );
  if projection ->> 'outcome' <> 'completed' then
    raise exception using errcode = '55000',
      message = 'Named action Record projection is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.save_named_action_set_fields_internal(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, text, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.save_named_action_set_fields_internal(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, text, uuid, bigint, uuid, jsonb
) is
  'Named-action set_field writer: rechecks authority and atomically writes the Record change, Activity, Event/queue and command receipt.';

create or replace function vortex_record.prepare_named_action_command_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_creations jsonb,
  p_activity_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  root_type jsonb;
  creation_count integer;
  before_closure jsonb;
  after_closure jsonb;
  link_targets jsonb;
  lock_plan jsonb;
  lock_entry jsonb;
  locked_value jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  source_field_id text;
  proposed_target jsonb;
  creation jsonb;
  access_loaded jsonb;
  access_decision jsonb;
  access_bounds jsonb := pg_catalog.jsonb_build_object('readableFieldIds', '[]'::jsonb);
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) <> 'object'
    or pg_catalog.jsonb_typeof(coalesce(p_creations, '[]'::jsonb)) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  creation_count := pg_catalog.jsonb_array_length(coalesce(p_creations, '[]'::jsonb));
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;
  -- Before-save Rule execution is #58's. The delivered set/announce path defers
  -- to the terminal writer's `contributes_to_total` probe; a create-bearing
  -- command refuses explicitly instead of being silently skipped.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- Authorize the subject without a row lock before discovering or locking any
  -- concrete dependency, through the installed named declaration. Executing a
  -- permitted action still requires no ordinary read or update authority.
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if access_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(access_loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (access_loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
  end if;
  access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);

  before_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  link_targets := vortex_record.named_action_command_link_targets_internal(
    catalogue, p_record_type_id, p_submitted_values, p_creations
  );
  if before_closure is null or link_targets is null then
    return case when creation_count = 0
      then pg_catalog.jsonb_build_object('outcome', 'defer')
      else pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      ) end;
  end if;

  -- One canonical row pass over the union of closure records (`for update`) and
  -- concrete link targets (`for share`). Taking both here, in one ascending
  -- concrete identity order, is what keeps a later `for share` inside the edge
  -- writer from queueing behind an exclusive waiter while this command already
  -- holds a resource that waiter needs.
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storageContractId', grouped.storage_contract_id,
      'recordId', grouped.record_id,
      'recordTypeId', grouped.record_type_id,
      'mode', case when grouped.exclusive then 'update' else 'share' end
    ) order by grouped.storage_contract_id, grouped.record_id
  ), '[]'::jsonb)
  into lock_plan
  from (
    select entry.storage_contract_id, entry.record_id, entry.record_type_id,
      pg_catalog.bool_or(entry.exclusive) as exclusive
    from (
      select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
        (item.value ->> 'recordId')::uuid as record_id,
        (item.value ->> 'recordTypeId')::uuid as record_type_id,
        true as exclusive
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value)
      where item.value ? 'recordId'
      union all
      select (item.value ->> 'storageContractId')::uuid,
        (item.value ->> 'recordId')::uuid,
        (item.value ->> 'recordTypeId')::uuid,
        false
      from pg_catalog.jsonb_array_elements(link_targets) item(value)
    ) entry
    group by entry.storage_contract_id, entry.record_id, entry.record_type_id
  ) grouped;

  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(lock_plan) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if lock_entry ->> 'mode' = 'update' then
      locked_value := vortex_record.relationship_total_record_snapshot_internal(
        catalogue, (lock_entry ->> 'recordTypeId')::uuid,
        (lock_entry ->> 'recordId')::uuid, true
      );
      if locked_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'restart');
      end if;
    elsif not vortex_record.share_lock_named_action_target_internal(
      catalogue, (lock_entry ->> 'recordTypeId')::uuid, (lock_entry ->> 'recordId')::uuid
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  -- A creation's link target is an ordinary record and keeps the ordinary read
  -- requirement. Deciding it here, under the lock and before any write, turns
  -- an unreadable target into a clean refusal instead of a late rollback. The
  -- command's own subject is excluded: the named authority decided above is
  -- sufficient for it, and requiring ordinary read would contradict #50.
  for lock_entry in
    select item.value
    from pg_catalog.jsonb_array_elements(link_targets) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    if (lock_entry ->> 'recordTypeId')::uuid = p_record_type_id
      and (lock_entry ->> 'recordId')::uuid = p_record_id then
      continue;
    end if;
    target_loaded := vortex_record.load_record_access_facts_internal(
      (lock_entry ->> 'recordTypeId')::uuid, 'read',
      (lock_entry ->> 'recordId')::uuid, null
    );
    if target_loaded ->> 'outcome' <> 'loaded'
      or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      target_loaded -> 'declaration', (lock_entry ->> 'recordId')::uuid,
      target_loaded -> 'facts'
    );
    if target_decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_target_unavailable'
      );
    end if;
  end loop;

  after_closure := vortex_record.named_action_command_closure_internal(
    catalogue, p_record_type_id, p_record_id, p_submitted_values, p_creations
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    return pg_catalog.jsonb_build_object('outcome', 'defer');
  end if;
  if (
    select (item.value ->> 'concurrencyNumber')::bigint
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where item.value ->> 'recordKey' = 'root'
  ) <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  access_loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if access_loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_decision := vortex_access.evaluate_organization_record_access_internal(
    access_loaded -> 'declaration', p_record_id, access_loaded -> 'facts'
  );
  if access_decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  access_bounds := vortex_access.resolve_record_field_bounds_internal(access_decision);

  -- `not_required` is decided over the union of the subject type and every
  -- creation target type, and only after the locks above, so a command that
  -- needs no total still acquires its resources in the canonical order.
  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    join pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
      on true
    where field.value ->> 'type' = 'total'
  ) and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    where pg_catalog.jsonb_array_length(
      coalesce(item.value -> 'recordType' -> 'relationships', '[]'::jsonb)
    ) > 0
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'not_required');
  end if;

  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
  loop
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      source_records := '[]'::jsonb;
      if prepared_record ? 'recordId' then
        for edge_value in
          select edge.* from vortex_record.relationship_edges edge
          where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
            and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
            and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
            and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
            and edge.from_organisation_id = context_organization_id
            and edge.to_organisation_id = context_organization_id
            and edge.from_application_root_id is not distinct from case
              when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end
            and edge.to_application_root_id is not distinct from case
              when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
          order by edge.from_storage_contract_id, edge.from_record_id
        loop
          source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, false
          );
          if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
            return pg_catalog.jsonb_build_object('outcome', 'restart');
          end if;
          select item.value ->> 'recordKey' into source_key
          from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
          where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
            and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'fieldValues', source_snapshot -> 'existingValues'
            ) || case when source_key is null then '{}'::jsonb
              else pg_catalog.jsonb_build_object('recordKey', source_key) end
          );
        end loop;
      end if;

      -- Replace the command source's old membership with its proposed one.
      if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') =
          pg_catalog.lower(p_record_type_id::text) then
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        select item.value -> 'existingValues' -> source_field_id into proposed_target
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if p_submitted_values ? source_field_id then
          proposed_target := p_submitted_values -> source_field_id;
        end if;
        source_records := coalesce((
          select pg_catalog.jsonb_agg(item.value order by item.ordinality)
          from pg_catalog.jsonb_array_elements(source_records) with ordinality item(value, ordinality)
          where item.value ->> 'recordKey' is distinct from 'root'
        ), '[]'::jsonb);
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and proposed_target ->> 'recordTypeId' = prepared_record ->> 'recordTypeId'
          and proposed_target ->> 'recordId' = prepared_record ->> 'recordId' then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('recordKey', 'root', 'fieldValues', '{}'::jsonb)
          );
        end if;
      end if;

      -- Each creation that links to this parent through this relationship joins
      -- its membership. A created record has no edges yet, so nothing is
      -- removed; the evaluator substitutes its computed values by record key.
      for creation in
        select item.value
        from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
          with ordinality item(value, ordinality)
        order by item.ordinality
      loop
        if pg_catalog.lower(relationship_value ->> 'fromRecordTypeId') <>
          pg_catalog.lower((creation ->> 'recordTypeId')::uuid::text) then
          continue;
        end if;
        source_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
        proposed_target := creation -> 'values' -> source_field_id;
        if pg_catalog.jsonb_typeof(proposed_target) = 'object'
          and pg_catalog.lower(proposed_target ->> 'recordTypeId') =
            pg_catalog.lower(prepared_record ->> 'recordTypeId')
          and pg_catalog.lower(proposed_target ->> 'recordId') =
            pg_catalog.lower(prepared_record ->> 'recordId') then
          source_records := source_records || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'recordKey', 'create:' || (creation ->> 'ordinal'),
              'fieldValues', '{}'::jsonb
            )
          );
        end if;
      end loop;

      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', access_bounds -> 'readableFieldIds',
    'records', prepared_records
  );
exception
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

revoke all on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_named_action_command_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, text, uuid, bigint, uuid
) is
  'Private named-action command preflight: one merged total closure over the subject and every creation, locked once in canonical concrete identity order. Writes nothing.';

create or replace function vortex_record.save_named_action_effects_with_relationship_totals(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb,
  p_declared_occurrence_ids jsonb,
  p_creations jsonb,
  p_creation_occurrence_ids jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_inputs jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer;
  preparation_value jsonb;
  result_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  inserted_value jsonb;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  changed_field_ids uuid[];
  occurrence_id_value uuid;
  event_result jsonb;
  copy_plan jsonb;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creations) <> 'array'
    or pg_catalog.jsonb_typeof(p_creation_occurrence_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_creations) <>
      pg_catalog.jsonb_array_length(p_creation_occurrence_ids) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  creation_count := pg_catalog.jsonb_array_length(p_creations);
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;

  if not vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    creation_plan := vortex_record.named_action_creation_plan_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_creations
    );
    if creation_plan ->> 'outcome' = 'unsupported' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
      );
    end if;
    if creation_plan ->> 'outcome' <> 'planned' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
      );
    end if;
    create_targets := creation_plan -> 'createTargets';

    preparation_value := vortex_record.prepare_named_action_command_totals(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      p_submitted_values, p_creations, p_activity_id, p_action_owner_kind,
      p_action_owner_id, p_action_release_revision, p_action_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      -- Preserved unchanged from `save_base_record_with_relationship_totals`
      -- (`20260914013000:817-904`): with an installed Rule the closure is not
      -- computed, so a command that would move a total must refuse rather than
      -- silently skip it. A create-bearing command already refused inside the
      -- preparation, so only the delivered set/announce shape reaches here.
      catalogue := vortex_record.relationship_total_catalogue_internal();
      if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
        closure_value := vortex_record.discover_relationship_total_closure_internal(
          catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
        );
        select item.value into root_type
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') =
          pg_catalog.lower(p_record_type_id::text);
        select item.value into root_snapshot
        from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if root_type is null or root_snapshot is null then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
        for relationship_value, target_type in
          select item.value, target.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
            on vortex_record.relationship_declares_target_internal(
              item.value, (target.value ->> 'recordTypeId')::uuid
            )
          where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
          order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
        loop
          relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
          old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
          proposed_relationship_target := old_relationship_target;
          if p_submitted_values ? relationship_field_id then
            proposed_relationship_target := p_submitted_values -> relationship_field_id;
          end if;
          if not (
            (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
              pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
            or
            (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
              pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
          ) then
            continue;
          end if;
          for total_field in
            select field.value
            from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
            where field.value ->> 'type' = 'total'
              and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                pg_catalog.lower(relationship_value ->> 'relationshipId')
          loop
            if p_submitted_values ? relationship_field_id and
              p_submitted_values -> relationship_field_id is distinct from
                coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
              contributes_to_total := true;
              exit;
            end if;
            dependency_contract := vortex_record.total_dependency_contract_internal(
              catalogue -> 'recordTypes',
              pg_catalog.jsonb_build_array(relationship_value),
              (target_type ->> 'recordTypeId')::uuid, total_field
            );
            for dependency_field_id in
              select item.value
              from pg_catalog.jsonb_array_elements_text(
                dependency_contract -> 'sourceFieldIds'
              ) item(value)
            loop
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
            end loop;
            exit when contributes_to_total;
          end loop;
          exit when contributes_to_total;
        end loop;
        if contributes_to_total then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    if preparation_value ->> 'outcome' is distinct from 'prepared' then
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
        preparation_value := null;
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    else
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.lower(field.value ->> 'fieldId')
              order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
            )
            from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
            where field.value ->> 'type' in ('total', 'calculation')
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into expected_parents
      from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
      where item.value ->> 'recordKey' <> 'root'
        and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
            from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into supplied_parents
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;

  -- #570: copy_relationships. The target row and every linked row are locked
  -- here, before the counters and data versions below and before any edge
  -- identity, so the lock classes keep their order. A replay copies nothing.
  if not vortex_record.command_receipt_exists_internal('named_action', p_command_id) then
    copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id, p_inputs
    );
    if copy_plan ->> 'outcome' = 'refused' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
      );
    end if;
  end if;
  -- #569: take every created record's reference-number counter (L4), then the
  -- data version of the subject's and every created record's storage scope,
  -- before the subject writer writes the subject's relationship edges (L6),
  -- matching ordinary create's row, counter, data version, edge order.
  if creation_count > 0 and create_targets is not null then
    perform vortex_record.reserve_named_action_creation_locks_internal(
      p_record_type_id, p_creations
    );
  end if;
  result_value := vortex_record.save_named_action_set_announce(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_submitted_values, p_final_values, p_activity_id, p_occurrence_id,
    p_declared_occurrence_ids, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_inputs
  );
  -- The subject writer reports 'saved' when it wrote the subject and
  -- 'completed' when the action had nothing to write to it. Both are a claimed
  -- receipt and a committed subject step; only a replay short-circuits here.
  if result_value ->> 'outcome' not in ('saved', 'completed')
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Step 4: every insert, in authored effect order, before any edge. Each
    -- allocates its reference numbers (L4); keeping the whole set ahead of the
    -- edge pass is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Step 5: every edge, in one canonical order across all creations: by
    -- relationship, then target, matching the ascending relationship edge
    -- identity order every ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(p_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        p_action_owner_kind, p_action_owner_id, p_action_release_revision,
        p_action_id, p_record_type_id, p_record_id
      );
    end loop;

    -- Step 6: the exact create decision only exists now, with the derived owner
    -- and the complete new graph in place. A denial raises, rolling the whole
    -- command back with no post-rollback refusal Activity (#50 section 8).
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      perform vortex_record.authorize_named_action_created_record_internal(
        (creation ->> 'recordTypeId')::uuid, created_record_id, submitted_field_ids
      );
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(p_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(p_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_event.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023',
        message = 'Relationship total parent mutation is incomplete';
    end if;
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', created_records);
end
$function$;

revoke all on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) to vortex_runtime;
comment on function vortex_record.save_named_action_effects_with_relationship_totals(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint, uuid, jsonb
) is
  'Protected named action composed with created records, their edges, authority, Activity and Events, and revision-checked parent totals, in one transaction.';

create or replace function vortex_record.assert_record_lifecycle_receipt_completed_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.organization_id = new.organization_id
      and receipt.application_root_id = new.application_root_id
      and receipt.actor_organization_account_id = new.actor_organization_account_id
      and receipt.command_kind = new.command_kind
      and receipt.command_id = new.command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '23514',
      message = 'Record lifecycle command was not finalized';
  end if;
  return null;
end
$function$;

revoke all on function vortex_record.assert_record_lifecycle_receipt_completed_internal(
  
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.assert_record_lifecycle_receipt_completed_internal(
  
) is
  'Deferred commit-time check that a record lifecycle command receipt never commits while pending.';

create or replace function vortex_record.append_record_lifecycle_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
begin
  bound_command_id := pg_catalog.nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then
    return;
  end if;
  receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', bound_command_id);
  if receipt.command_id is null
    or receipt.state is distinct from 'pending'
    or (receipt.operation = 'delete'
      and p_effect_kind not in ('soft_deleted', 'optional_cleared'))
    or (receipt.operation = 'restore' and p_effect_kind is distinct from 'restored') then
    raise exception using errcode = '42501',
      message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1 into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number
  ) values (
    receipt.organization_id, receipt.application_root_id,
    receipt.actor_organization_account_id, receipt.command_id, next_sequence,
    p_effect_kind, p_storage_contract_id, p_record_type_id, p_record_id,
    p_relationship_id, p_pre_concurrency_number, p_pre_concurrency_number + 1
  );
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.append_record_lifecycle_effect_internal(
  text, uuid, uuid, uuid, bigint, uuid
) is
  'Journals one lifecycle effect for the command bound to this transaction; it does nothing when no command is bound.';

create or replace function vortex_record.prepare_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record delete requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'delete', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'delete', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', null,
      'activityId', p_activity_id,
      'occurrenceId', p_occurrence_id
    ), false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  -- The evaluator needs the root's last active values. They are captured
  -- before the traversal and only used if that traversal deletes exactly the
  -- revision they were read at.
  root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
    vortex_record.relationship_total_catalogue_internal(),
    p_record_type_id, p_record_id, false
  );

  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  deletion_result := vortex_record.soft_delete_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  if deletion_result ->> 'outcome' = 'conflict' then
    current_revision := vortex_record.record_lifecycle_current_revision_internal(
      p_record_type_id, p_record_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when current_revision is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
  end if;
  if deletion_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;
  if root_snapshot is null then
    raise exception using errcode = '55000',
      message = 'Protected record delete root is not installed';
  end if;
  if (root_snapshot ->> 'concurrencyNumber')::bigint
      is distinct from p_expected_concurrency_number then
    raise exception using errcode = '40001',
      message = 'Protected record delete root changed before deletion';
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot
  );
end
$function$;

revoke all on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_delete(
  uuid, uuid, uuid, bigint, uuid, uuid
) is
  'Protected delete preflight: receipt, recursive soft delete and the locked dependency-total closure of every affected parent.';

create or replace function vortex_record.prepare_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  receipt_claim jsonb;
  restore_result jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  policy_value jsonb;
  refusal_reason text;
  expected_policy_revision bigint;
  deleted_value timestamptz;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';

  -- The recovery window is decided from this record's own deletion time, read
  -- before the restore primitive clears it, and from the stored policy of its
  -- exact target, share-locked until commit. The row is read unlocked: the
  -- primitive locks it and accepts only the expected revision, and a revision
  -- only ever advances, so a matching read is the same deleted row. Nothing
  -- from this read is returned unless the primitive has accepted the actor.
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  if found then
    policy_value := vortex_record.lock_record_recovery_policy_internal(
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
    expected_policy_revision := (policy_value ->> 'policyRevision')::bigint;
    execute pg_catalog.format(
      'select stored.deleted_at from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is not distinct from $3
         and stored.lifecycle_state = ''soft_deleted''
         and stored.concurrency_number = $4',
      storage_row.physical_table_token
    ) into deleted_value using
      (context_value ->> 'organizationId')::uuid, p_record_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end,
      p_expected_concurrency_number;
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'restore', fingerprint_value,
    p_record_type_id, p_record_id, '{}'::jsonb,
    pg_catalog.jsonb_build_object(
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'recoveryPolicyRevision', expected_policy_revision,
      'activityId', p_activity_id,
      'occurrenceId', null
    ), false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', receipt_claim -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
      'correlationId', correlation_value,
      'replayed', true
    );
  end if;

  restore_result := vortex_record.restore_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if restore_result ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when pg_catalog.jsonb_typeof(restore_result -> 'concurrencyNumber') = 'number'
      then pg_catalog.jsonb_build_object(
        'concurrencyNumber', restore_result -> 'concurrencyNumber'
      ) else '{}'::jsonb end;
  end if;
  if restore_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(restore_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;

  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  perform vortex_record.append_record_lifecycle_effect_internal(
    'restored', storage_row.storage_contract_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, null
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  policy_value := vortex_record.lock_record_recovery_policy_internal(
    (context_value ->> 'organizationId')::uuid,
    storage_row.storage_contract_id,
    case when storage_row.storage_scope = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end
  );
  refusal_reason := case
    when policy_value is null then 'policy_unavailable'
    when policy_value ->> 'action' is distinct from 'delete' then 'recovery_action_ineligible'
    when (policy_value ->> 'policyRevision')::bigint
      is distinct from expected_policy_revision then 'policy_revision_stale'
    when pg_catalog.jsonb_typeof(policy_value -> 'recoveryWindowDays')
      is distinct from 'number' then 'policy_unavailable'
    when deleted_value is null then 'malformed_input'
    when pg_catalog.date_part(
      'epoch', pg_catalog.statement_timestamp() - deleted_value
    ) >= (policy_value ->> 'recoveryWindowDays')::numeric * 86400
      then 'recovery_window_expired'
    else null end;
  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_ineligible',
      'recoveryReason', refusal_reason,
      'governingPolicyRevision', policy_value -> 'policyRevision',
      'correlationId', correlation_value
    );
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
end
$function$;

revoke all on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_protected_record_restore(
  uuid, uuid, uuid, bigint, uuid
) is
  'Protected restore preflight: receipt, restore primitive, share-locked recovery-policy check, the recovery window from the record''s own deletion time and the locked dependency-total closure.';

create or replace function vortex_record.finalize_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
begin
  context_value := vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
  if receipt.command_id is null
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record delete is not prepared';
  end if;

  -- Closure identity and revisions are re-derived under the held locks rather
  -- than taken from the caller.
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '40001',
      message = 'Protected record delete closure changed';
  end if;
  perform vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, false, p_parent_mutations
  );

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind = 'soft_deleted' then
      event_kind := 'deleted';
    else
      event_kind := 'unlinked';
    end if;
    event_result := vortex_event.append_record_occurrences(
      effect_row.storage_contract_id, effect_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', case
          when event_kind = 'deleted' and effect_row.record_id = p_record_id
            and effect_row.record_type_id = p_record_type_id
            then receipt.occurrence_id
          else pg_catalog.gen_random_uuid() end,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', effect_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object('kind', event_kind)
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000',
        message = 'Protected record delete Event append failed';
    end if;
  end loop;

  select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
    into subject_ids
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  if subject_ids is null or not (p_record_id = any (subject_ids)) then
    raise exception using errcode = '55000',
      message = 'Protected record delete effects are unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'delete', subject_ids
  );

  perform vortex_record.complete_command_receipt_internal(
    'record_lifecycle', p_command_id, null, p_expected_concurrency_number + 1,
    'Protected record delete receipt is stale'
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_delete(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected delete writer: generated parent values, standard Events, Activity and receipt in the preflight transaction.';

create or replace function vortex_record.finalize_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  revisions jsonb;
  restored_revision bigint;
begin
  context_value := vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal('record_lifecycle', p_command_id);
  if receipt.command_id is null
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'restore'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record restore is not prepared';
  end if;

  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared'
    or (
      select (item.value ->> 'concurrencyNumber')::bigint
      from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
      where item.value ->> 'recordKey' = 'root'
    ) is distinct from p_expected_concurrency_number + 1 then
    raise exception using errcode = '40001',
      message = 'Protected record restore closure changed';
  end if;
  revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, true, p_mutations
  );
  select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
  from pg_catalog.jsonb_array_elements(revisions) as item(value)
  where item.value ->> 'recordKey' = 'root';

  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'restore', array[p_record_id]::uuid[]
  );

  perform vortex_record.complete_command_receipt_internal(
    'record_lifecycle', p_command_id, null, restored_revision,
    'Protected record restore receipt is stale'
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'recordId', p_record_id,
    'concurrencyNumber', restored_revision,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
)
  to vortex_runtime;
comment on function vortex_record.finalize_protected_record_restore(
  uuid, uuid, uuid, bigint, jsonb
) is
  'Protected restore writer: refreshed generated values of the record and its parents, Activity and receipt in the preflight transaction.';

create or replace function vortex_record.named_action_deleted_subject_replay_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  receipt_claim jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'soft_delete_subject'
  ) then
    return null;
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_lifecycle', p_command_id, 'delete',
    vortex_record.record_lifecycle_command_fingerprint_internal(
      p_command_id, 'delete', p_record_type_id, p_record_id,
      p_expected_concurrency_number
    ),
    p_record_type_id, p_record_id, '{}'::jsonb, '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'completed' then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'recordId', receipt_claim -> 'recordId',
    'concurrencyNumber', receipt_claim -> 'concurrencyNumber',
    'values', '{}'::jsonb,
    'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
    'backgroundDelivery', 'pending',
    'replayed', true
  );
end
$function$;

revoke all on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
comment on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) is
  'Private named-action step: for an installed action that declares soft_delete_subject, reports the stored outcome of the completed protected delete carrying the same command identity and revision (the deleted revision and no values), because a deleted subject cannot be projected. Returns null otherwise.';

-- A pending lifecycle receipt reaching commit means a preflight was never
-- finalized. Save and named-action receipts are claimed and completed inside
-- one writer call, as before.
create constraint trigger command_receipts_lifecycle_completed_at_commit
after insert or update on vortex_record.command_receipts
deferrable initially deferred
for each row
when (new.command_kind = 'record_lifecycle')
execute function vortex_record.assert_record_lifecycle_receipt_completed_internal();

drop function vortex_record.record_lifecycle_receipt_outcome_internal(uuid, text, text);

drop table vortex_record.save_command_receipts;
drop table vortex_record.named_action_command_receipts;
drop table vortex_record.record_lifecycle_command_receipts;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
