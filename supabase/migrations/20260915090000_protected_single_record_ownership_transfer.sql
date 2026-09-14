-- One fixed, server-only ownership transfer.  This is deliberately not an
-- ordinary field change or a named-action dispatcher: it accepts one concrete
-- record, one expected revision and one compatible owner target.

begin;

-- The Record adapter can ask Access only for the two facts a transfer needs.
-- These locks also serialize a target archival with a transfer.  They do not
-- grant Record a readable account, Group or membership ledger.
create function vortex_access.lock_active_record_ownership_target_internal(
  p_kind text,
  p_target_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_kind not in ('organization_account', 'group')
    or p_target_id is null
    or p_target_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_kind = 'organization_account' then
    select true into matched
    from vortex_identity.organization_accounts as account
    where account.organization_id = (context_value ->> 'organizationId')::uuid
      and account.organization_account_id = p_target_id
      and account.state = 'active'
    for share of account;
  else
    select true into matched
    from vortex_access.organization_groups as organization_group
    where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
      and organization_group.group_id = p_target_id
      and organization_group.state = 'active'
    for share of organization_group;
  end if;
  return coalesce(matched, false);
end
$function$;

alter function vortex_access.lock_active_record_ownership_target_internal(text, uuid)
  owner to postgres;
revoke all on function vortex_access.lock_active_record_ownership_target_internal(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_access.lock_active_record_ownership_target_internal(text, uuid)
  to vortex_record_adapter;
comment on function vortex_access.lock_active_record_ownership_target_internal(text, uuid) is
  'Private exact active same-organisation account or Group target check for the fixed Record ownership-transfer operation.';

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;

-- `transfer` is a record-scoped permission kind, distinct from ordinary
-- update.  Existing permission declaration/role assignment machinery carries
-- it unchanged; no new capability registry or generic action is introduced.
alter table vortex_access.permission_catalogue_entries
  drop constraint permission_catalogue_entries_action_kind_valid;
alter table vortex_access.permission_catalogue_entries
  add constraint permission_catalogue_entries_action_kind_valid check (
    action_kind in ('create', 'read', 'update', 'delete', 'restore', 'export',
      'share', 'manage', 'transfer', 'named')
  );

do $migration$
declare
  signature regprocedure;
  existing_definition text;
  extended_definition text;
begin
  foreach signature in array array[
    'vortex_access.evaluate_organization_permission_eligibility(jsonb)'::regprocedure,
    'vortex_access.evaluate_organization_record_permission_eligibility_internal(jsonb,jsonb,timestamptz)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(signature) into strict existing_definition;
    extended_definition := pg_catalog.replace(
      existing_definition,
      '''create'', ''read'', ''update'', ''delete'', ''restore'', ''export'', ''share'', ''manage'', ''named''',
      '''create'', ''read'', ''update'', ''delete'', ''restore'', ''export'', ''share'', ''manage'', ''transfer'', ''named'''
    );
    if extended_definition = existing_definition then
      raise exception using errcode = '55000',
        message = 'Permission eligibility action selector does not match its reviewed prerequisite';
    end if;
    execute extended_definition;
  end loop;
end
$migration$;

set local role vortex_record_adapter;

do $migration$
declare
  existing_definition text;
  extended_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint)'::regprocedure
  ) into strict existing_definition;
  extended_definition := pg_catalog.replace(
    existing_definition,
    '''create'', ''read'', ''update'', ''delete'', ''restore''',
    '''create'', ''read'', ''update'', ''delete'', ''restore'', ''transfer'''
  );
  if extended_definition = existing_definition then
    raise exception using errcode = '55000',
      message = 'Record facts transfer selector does not match its reviewed prerequisite';
  end if;
  execute extended_definition;
end
$migration$;

-- Reuse the existing bounded receipt store.  Transfer is still one record
-- command, not an offboarding batch/job ledger.
alter table vortex_record.save_command_receipts
  drop constraint save_command_receipts_operation_valid;
alter table vortex_record.save_command_receipts
  add constraint save_command_receipts_operation_valid check (
    operation in ('create', 'update', 'transfer_ownership')
  );

create function vortex_record.ownership_transfer_command_fingerprint_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'commandId', p_command_id,
      'operation', 'transfer_ownership',
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'targetKind', p_target_kind,
      'targetId', p_target_id
    )::text, 'UTF8')), 'hex'
  )
$function$;

-- The Activity shape is closed here so a terminal Record writer can record a
-- transfer without gaining Activity's generic append capability.  A refusal's
-- subject is always the context organisation, per #41; completed activity is
-- about the record and carries neither old nor new owner values.
set local role postgres;
create function vortex_record.append_ownership_transfer_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record ownership transfer Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'transfer_record_ownership', array[p_subject_id]::uuid[], array[]::uuid[],
    'web', (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record ownership transfer Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

set local role vortex_record_adapter;
create function vortex_record.transfer_record_ownership(
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
  receipt vortex_record.save_command_receipts%rowtype;
  inserted_command_id uuid;
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
    or p_expected_concurrency_number not between 1 and 9007199254740990
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
    p_target_kind, p_target_id
  );

  insert into vortex_record.save_command_receipts (
    organization_id, application_root_id, actor_organization_account_id, command_id,
    command_fingerprint, record_type_id, operation, state
  ) values (
    organization_id_value, application_root_id_value, actor_id_value, p_command_id,
    command_fingerprint_value, p_record_type_id, 'transfer_ownership', 'pending'
  ) on conflict do nothing returning command_id into inserted_command_id;

  if inserted_command_id is null then
    select stored.* into strict receipt from vortex_record.save_command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_id = p_command_id for update;
    if receipt.command_fingerprint is distinct from command_fingerprint_value
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.operation is distinct from 'transfer_ownership' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_identity_conflict');
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    -- A replay reprojects from current access and intentionally never returns
    -- owner metadata (including the prior target).
    projection := vortex_record.read_record(p_record_type_id, receipt.record_id);
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
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
  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'transfer', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into record_type_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or record_type_fact is null
    or record_fact ->> 'lifecycleState' <> 'active' then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  ownership_mode := record_type_fact ->> 'ownershipMode';
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(
      p_activity_id, organization_id_value, 'refused'
    );
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused_recorded', 'reasonCode', 'record_unavailable');
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
  end if;
  if ownership_mode = 'organization_account' then
    previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
  elsif ownership_mode = 'team' then
    previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
  else
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'ownership_unavailable');
  end if;
  if (ownership_mode = 'organization_account' and p_target_kind <> 'organization_account')
    or (ownership_mode = 'team' and p_target_kind <> 'group')
    or previous_owner_id is null or previous_owner_id = p_target_id
    or not vortex_access.lock_active_record_ownership_target_internal(p_target_kind, p_target_id) then
    delete from vortex_record.save_command_receipts where organization_id = organization_id_value
      and application_root_id = application_root_id_value and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'owner_unavailable');
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
  update vortex_record.save_command_receipts as stored set state = 'completed',
    record_id = p_record_id, concurrency_number = updated_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = organization_id_value
    and stored.application_root_id = application_root_id_value
    and stored.actor_organization_account_id = actor_id_value
    and stored.command_id = p_command_id and stored.state = 'pending';
  if not found then raise exception using errcode = '40001', message = 'Record ownership transfer receipt is stale'; end if;
  projection := vortex_record.read_record(p_record_type_id, p_record_id);
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000', message = 'Transferred Record projection is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'transferred', 'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'correlationId', context_value -> 'correlationId', 'replayed', false
  );
end
$function$;

alter function vortex_record.ownership_transfer_command_fingerprint_internal(uuid, uuid, uuid, bigint, text, uuid)
  owner to vortex_record_adapter;
alter function vortex_record.transfer_record_ownership(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid)
  owner to vortex_record_adapter;
reset role;
set local role postgres;
revoke all on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.append_ownership_transfer_activity_internal(uuid, uuid, text)
  to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;
revoke all on function vortex_record.ownership_transfer_command_fingerprint_internal(uuid, uuid, uuid, bigint, text, uuid),
  vortex_record.transfer_record_ownership(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.transfer_record_ownership(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid)
  to vortex_runtime;
comment on function vortex_record.transfer_record_ownership(uuid, uuid, uuid, bigint, text, uuid, uuid, uuid) is
  'Fixed server-only single-record ownership transfer: current explicit transfer authority, compatible active target and expected revision, atomically with Activity, reassigned Event/queue and receipt.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;
commit;
