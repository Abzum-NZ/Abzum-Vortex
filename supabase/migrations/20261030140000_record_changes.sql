set role vortex_owner;

grant create on schema vortex_record to vortex_record_adapter;

grant update on vortex_record.relationship_edges to vortex_record_adapter;
create policy relationship_edges_adapter_update on vortex_record.relationship_edges
  for update to vortex_record_adapter
  using (from_organisation_id = (select vortex_platform.organization_id()))
  with check (
    from_organisation_id = (select vortex_platform.organization_id())
    and to_organisation_id = (select vortex_platform.organization_id())
  );

alter table vortex_record.organization_activity_entries
  add column agent_channel text,
  add constraint organization_activity_entries_agent_channel_valid check (agent_channel in ('webmcp', 'mcp'));
comment on column vortex_record.organization_activity_entries.agent_channel is
  'Trusted agent channel acting for the unchanged actor; null for work not initiated through WebMCP or MCP.';

create or replace function vortex_record.append_organization_activity_entry(
  p_organization_id uuid,
  p_activity_id uuid,
  p_occurred_at timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_source text,
  p_correlation_id uuid,
  p_outcome text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  inserted_activity_id uuid;
  existing_entry vortex_record.organization_activity_entries%rowtype;
  channel_value text := vortex_platform.channel();
  agent_channel_value text;
begin
  agent_channel_value := case when channel_value in ('webmcp', 'mcp')
    then channel_value else null end;
  if p_source is null
    or p_source <> all (array[
      'web', 'webmcp', 'mcp', 'programmatic_interface', 'connection', 'federation',
      'system'
    ]) then
    raise exception using errcode = '22023', message = 'Activity source channel is invalid';
  end if;

  insert into vortex_record.organization_activity_entries (
    organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
    subject_ids, changed_field_ids, source, correlation_id, outcome, agent_channel
  ) values (
    p_organization_id, p_activity_id, p_occurred_at, p_actor_kind, p_actor_id,
    p_action, p_subject_ids, p_changed_field_ids, p_source, p_correlation_id,
    p_outcome, agent_channel_value
  )
  on conflict (organization_id, activity_id) do nothing
  returning activity_id into inserted_activity_id;

  if inserted_activity_id is not null then
    return 'inserted';
  end if;

  select entry.*
  into strict existing_entry
  from vortex_record.organization_activity_entries as entry
  where entry.organization_id = p_organization_id
    and entry.activity_id = p_activity_id;

  if existing_entry.occurred_at is distinct from p_occurred_at
    or existing_entry.actor_kind is distinct from p_actor_kind
    or existing_entry.actor_id is distinct from p_actor_id
    or existing_entry.agent_channel is distinct from agent_channel_value
    or existing_entry.action is distinct from p_action
    or existing_entry.subject_ids is distinct from p_subject_ids
    or existing_entry.changed_field_ids is distinct from p_changed_field_ids
    or existing_entry.source is distinct from p_source
    or existing_entry.correlation_id is distinct from p_correlation_id
    or existing_entry.outcome is distinct from p_outcome then
    raise exception using
      errcode = '22023',
      message = 'Activity identity already records different evidence';
  end if;

  return 'already_recorded';
end
$function$;

revoke all on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) is
  'Private content-free Activity append over the one channel vocabulary; an exact retry replays and different evidence under one identity is refused.';

alter function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) owner to vortex_owner;

grant execute on function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) to postgres;

create or replace function vortex_record.append_record_activity_internal(
  p_activity_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
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
    or p_action is null
    or p_action not in (
      'create_record', 'update_record', 'execute_named_action', 'delete_record',
      'restore_record', 'transfer_record_ownership', 'manage_record_lifecycle_policy'
    )
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    )
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome is null
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_action in (
      'create_record', 'update_record', 'delete_record', 'restore_record',
      'transfer_record_ownership'
    )
    and not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record Activity requires an Application context';
  end if;
  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action, p_subject_ids, p_changed_field_ids, vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

alter function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  owner to vortex_owner;
revoke all on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text) is
  'The one Record Activity composer: derives the organisation, account, correlation and channel from the validated request context and appends one entry for a record save, named action, delete, restore, ownership transfer or lifecycle policy change. The append records webmcp or mcp as the agent channel while the actor remains the person.';

set role vortex_record_adapter;

alter table vortex_record.record_lifecycle_command_effects
  add column previous_value jsonb,
  drop constraint record_lifecycle_command_effects_kind_valid,
  add constraint record_lifecycle_command_effects_kind_valid
    check (effect_kind in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')),
  add constraint record_lifecycle_command_effects_previous_value_valid check (
    previous_value is null or (
      effect_kind = 'optional_cleared'
      and pg_catalog.jsonb_typeof(previous_value) = 'object'
      and previous_value ?& array['recordTypeId', 'recordId']
      and previous_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
      and vortex_platform.is_non_nil_uuid(previous_value ->> 'recordTypeId')
      and vortex_platform.is_non_nil_uuid(previous_value ->> 'recordId')
    )
  );
alter table vortex_record.record_lifecycle_command_effects add column delete_roots jsonb;
-- Existing commands have one root, recorded in their completed receipt. Rebuild
-- their journal into the same root format used by new sets.
update vortex_record.record_lifecycle_command_effects as effect
set delete_roots = (
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId', root.record_type_id, 'recordId', root.record_id
  ))
  from vortex_record.command_receipts as receipt
  join lateral (
    select candidate.record_type_id, candidate.record_id
    from vortex_record.record_lifecycle_command_effects as candidate
    where candidate.command_id = receipt.command_id
      and candidate.record_id = (receipt.result ->> 'recordId')::uuid
    order by candidate.effect_sequence desc limit 1
  ) as root on true
  where receipt.command_id = effect.command_id
);
alter table vortex_record.record_lifecycle_command_effects
  alter column delete_roots set not null,
  add constraint record_lifecycle_command_effects_roots_valid
    check (pg_catalog.jsonb_typeof(delete_roots) = 'array' and delete_roots <> '[]'::jsonb);
comment on column vortex_record.record_lifecycle_command_effects.delete_roots is
  'Every delete root whose closure reached this effect; restoring one root selects only its effects.';

comment on table vortex_record.record_lifecycle_command_effects is
  'Private lifecycle command journal: affected record identities, revisions and the targets of optional links cleared by deletion.';
comment on column vortex_record.record_lifecycle_command_effects.previous_value is
  'The link target before an optional clear; restore recovers available snapshots and reports the count without one.';

drop function vortex_record.complete_command_receipt_internal(text,uuid,uuid,bigint,text);
drop function vortex_record.append_record_lifecycle_effect_internal(text,uuid,uuid,uuid,bigint,uuid);
drop function vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[]);
drop function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]);
drop function vortex_record.apply_record_lifecycle_generated_values_internal(jsonb,boolean,jsonb);
drop function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb);

create or replace function vortex_record.append_record_lifecycle_effect_internal(p_effects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
  receipt_kind text;
begin
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then return; end if;
  if pg_catalog.jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_effects) = 0 then return; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    where not (item.value ?& array['effectKind', 'storageContractId', 'recordTypeId', 'recordId', 'preConcurrencyNumber', 'relationshipId', 'previousValue', 'deleteRoots'])
      or item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')
      or pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') is distinct from 'array'
      or item.value -> 'deleteRoots' = '[]'::jsonb
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') = 'array'
            then item.value -> 'deleteRoots' else '[]'::jsonb end) as root(value)
        where pg_catalog.jsonb_typeof(root.value) is distinct from 'object'
          or not (root.value ?& array['recordTypeId', 'recordId'])
          or root.value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordTypeId')
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordId')
      )
      or (item.value ->> 'effectKind' = 'optional_cleared' and (
        pg_catalog.jsonb_typeof(item.value -> 'previousValue') is distinct from 'object'
        or not ((item.value -> 'previousValue') ?& array['recordTypeId', 'recordId'])
        or (item.value -> 'previousValue') - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordTypeId}')
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordId}')
      ))
      or (item.value ->> 'effectKind' <> 'optional_cleared' and item.value -> 'previousValue' <> 'null'::jsonb)
  ) then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  select stored.command_kind into receipt_kind
  from vortex_record.command_receipts as stored where stored.command_id = bound_command_id;
  if receipt_kind not in ('record_delete', 'record_restore', 'record_changes')
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
      where (receipt_kind = 'record_delete' and item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared'))
        or (receipt_kind = 'record_restore' and item.value ->> 'effectKind' not in ('restored', 'links_restored'))
    ) then
    raise exception using errcode = '42501', message = 'Record lifecycle command kind is invalid';
  end if;
  receipt := vortex_record.lock_command_receipt_internal(receipt_kind, bound_command_id);
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number, previous_value, delete_roots
  )
  select (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid, receipt.command_id,
    next_sequence + item.ordinality::integer, item.value ->> 'effectKind',
    (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordTypeId')::uuid,
    (item.value ->> 'recordId')::uuid, (item.value ->> 'relationshipId')::uuid,
    (item.value ->> 'preConcurrencyNumber')::bigint,
    (item.value ->> 'preConcurrencyNumber')::bigint + 1,
    nullif(item.value -> 'previousValue', 'null'::jsonb), item.value -> 'deleteRoots'
  from pg_catalog.jsonb_array_elements(p_effects) with ordinality as item(value, ordinality);
end
$function$;

alter function vortex_record.append_record_lifecycle_effect_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.append_record_lifecycle_effect_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.append_record_lifecycle_effect_internal(jsonb) is
  'Appends the prepared lifecycle effects in one journal write for the command bound to this transaction, retaining cleared link targets for exact recovery.';

create or replace function vortex_record.apply_lifecycle_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
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
  result_value jsonb;
  correlation_id_value uuid;
begin
  -- Closed lifecycle entry to apply_record_changes. Delete alone accepts null
  -- mutations to begin its traversal; the second call supplies calculated parent
  -- mutations and finalises the same command in the same request transaction. An account
  -- offboarding transfer enters only through transfer_offboarding_owned_record.
  if p_operation is null
    or p_operation not in ('delete', 'restore', 'transfer_ownership')
    or (pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      and not (p_operation in ('delete', 'restore') and p_mutations is null))
    or coalesce(pg_catalog.jsonb_path_exists(
      p_mutations, '$[*] ? (@.kind == "offboarding_transfer")'
    ), false) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  result_value := vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null,
    p_mutations, p_activity_id, p_occurrence_id
  );
  if p_operation <> 'transfer_ownership' then
    return result_value;
  end if;

  if result_value ->> 'outcome' = 'saved' then
    return result_value - array['values', 'backgroundDelivery']::text[]
      || pg_catalog.jsonb_build_object('outcome', 'transferred');
  end if;
  if result_value ->> 'outcome' in ('conflict', 'refused') then
    correlation_id_value :=
      (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
    return result_value || pg_catalog.jsonb_build_object('correlationId', correlation_id_value);
  end if;
  return result_value;
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The request role''s closed entry to delete preparation and finalisation, restore and ownership-transfer record-change writes: it refuses any other operation and an account offboarding transfer, and delegates once to the one protected apply_record_changes operation.';

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
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
  root_snapshot jsonb;
  deletion_result jsonb;
  deletion_plan jsonb;
  storage_changes jsonb;
  storage_set jsonb;
  generated_plan jsonb;
  parent_plan jsonb;
  written_revisions jsonb;
  storage_change jsonb;
  current_revision bigint;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- Delete has two calls in one request transaction: null mutations claim the
  -- receipt and traverse, then calculated parent mutations complete the command.
  -- Both calls enter through apply_record_changes; a non-final outcome rolls
  -- back the request transaction, including every traversal write.
  if p_operation = 'delete' then
    if p_mutations is null then
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
      receipt_claim := vortex_record.claim_command_receipt_internal(
        'record_delete', p_command_id, false
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
        return pg_catalog.jsonb_build_object(
          'outcome', 'deleted',
          'recordId', receipt_claim -> 'result' -> 'recordId',
          'concurrencyNumber', receipt_claim -> 'result' -> 'concurrencyNumber',
          'correlationId', context_value -> 'correlationId',
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
      begin
        deletion_plan := vortex_record.prepare_record_delete_closure_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
        );
        storage_set := vortex_record.prepare_record_storage_set_internal(deletion_plan -> 'storageChanges');
        perform vortex_record.append_record_lifecycle_effect_internal((
          select pg_catalog.jsonb_agg(distinct item.value order by item.value)
          from pg_catalog.jsonb_array_elements(deletion_plan -> 'effects') as item(value)
        ));
        deletion_result := pg_catalog.jsonb_build_object('outcome', 'completed');
      exception
        when serialization_failure or deadlock_detected then
          deletion_result := pg_catalog.jsonb_build_object('outcome', 'conflict');
        when no_data_found or insufficient_privilege or object_not_in_prerequisite_state then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'record_unavailable'
          );
        when check_violation then
          deletion_result := pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_refused'
          );
      end;
      perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

      if deletion_result ->> 'outcome' = 'conflict' then
        current_revision := vortex_record.record_lifecycle_current_revision_internal(
          p_record_type_id, p_record_id
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        ) || case when current_revision is null then '{}'::jsonb
          else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
      end if;
      if deletion_result ->> 'outcome' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
          'correlationId', context_value -> 'correlationId'
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
        'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot, storage_set -> 'proposedRecords'
      );
    end if;
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_delete', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record delete identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this delete.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind = 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;

    -- Closure identity and revisions are re-derived under the held locks rather
    -- than taken from the caller.
    deletion_plan := vortex_record.prepare_record_delete_closure_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
    );
    storage_set := vortex_record.prepare_record_storage_set_internal(deletion_plan -> 'storageChanges');
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'delete', p_record_type_id, p_record_id, p_command_id, null, storage_set -> 'proposedRecords'
    );
    if preparation ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001',
        message = 'Protected record delete closure changed';
    end if;
    generated_plan := vortex_record.prepare_record_lifecycle_generated_values_internal(
      preparation, false, p_mutations, storage_set -> 'proposedRecords'
    );
    storage_set := vortex_record.prepare_record_storage_set_internal(
      (storage_set -> 'storageChanges') || (generated_plan -> 'storageChanges')
    );
    storage_changes := storage_set -> 'storageChanges';
    perform vortex_record.apply_record_storage_changes_internal(storage_changes);
    perform vortex_record.apply_relationship_edges_internal((
      select coalesce(pg_catalog.jsonb_agg(distinct item.value order by item.value), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(deletion_plan -> 'edgeChanges') as item(value)
    ));
        for storage_change in
          select distinct pg_catalog.jsonb_build_object(
            'storageContractId', item.value -> 'storageContractId',
            'applicationRootId', case when storage.storage_scope = 'application_contained'
              then context_value -> 'applicationRootId' else null end
          )
          from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
          join vortex_record.storage_catalogue as storage
            on storage.storage_contract_id = (item.value ->> 'storageContractId')::uuid
          where storage.storage_scope <> 'application_contained'
            or exists (
              select 1 from pg_catalog.jsonb_array_elements(deletion_plan -> 'effects') as effect(value)
              where effect.value ->> 'effectKind' = 'optional_cleared'
                and effect.value -> 'storageContractId' = item.value -> 'storageContractId'
            )
        loop
          perform vortex_record.bump_record_data_version_internal(
            (context_value ->> 'organizationId')::uuid, (storage_change ->> 'storageContractId')::uuid,
            (storage_change ->> 'applicationRootId')::uuid
          );
        end loop;
    for parent_plan in select item.value from pg_catalog.jsonb_array_elements(generated_plan -> 'parentPlans') as item(value)
    loop
      perform vortex_record.complete_relationship_total_parent_internal(parent_plan);
    end loop;

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = (context_value ->> 'organizationId')::uuid
        and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then p_occurrence_id
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
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'delete_record', subject_ids, array[]::uuid[], 'completed');

    perform vortex_record.complete_command_receipt_internal(
      'record_delete', p_command_id,
      pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', p_expected_concurrency_number + 1),
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    if p_mutations is null then
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
      return vortex_record.prepare_record_restore_internal(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    end if;
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_restore', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record restore identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this restore.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind not in ('restored', 'links_restored')
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'restored'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;

    deletion_plan := vortex_record.prepare_record_restore_closure_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if deletion_plan ->> 'outcome' is distinct from 'prepared' then
      raise exception using errcode = '40001', message = 'Protected record restore closure changed';
    end if;
    storage_set := vortex_record.prepare_record_storage_set_internal(deletion_plan -> 'storageChanges');
    preparation := vortex_record.prepare_record_lifecycle_totals_internal(
      'restore', p_record_type_id, p_record_id, p_command_id, null, storage_set -> 'proposedRecords'
    );
    if preparation ->> 'outcome' is distinct from 'prepared'
      or (
        select (item.value ->> 'concurrencyNumber')::bigint
        from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
        where item.value ->> 'recordKey' = 'root'
      ) is distinct from p_expected_concurrency_number then
      raise exception using errcode = '40001',
        message = 'Protected record restore closure changed';
    end if;
    generated_plan := vortex_record.prepare_record_lifecycle_generated_values_internal(
      preparation, true, p_mutations, storage_set -> 'proposedRecords'
    );
    storage_set := vortex_record.prepare_record_storage_set_internal(
      (storage_set -> 'storageChanges') || (generated_plan -> 'storageChanges')
    );
    written_revisions := vortex_record.apply_record_storage_changes_internal(storage_set -> 'storageChanges');
    perform vortex_record.validate_record_restore_set_internal(deletion_plan -> 'subjects');
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recordKey', prepared.value -> 'recordKey',
      'concurrencyNumber', coalesce(written.value -> 'concurrencyNumber', prepared.value -> 'concurrencyNumber')
    )) into revisions
    from pg_catalog.jsonb_array_elements(preparation -> 'records') as prepared(value)
    left join pg_catalog.jsonb_array_elements(written_revisions) as written(value)
      on written.value -> 'recordId' = prepared.value -> 'recordId'
      and written.value -> 'storageContractId' = prepared.value -> 'storageContractId';
    for parent_plan in
      select item.value from pg_catalog.jsonb_array_elements(generated_plan -> 'parentPlans') as item(value)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(deletion_plan -> 'subjects') as restored(value)
        where restored.value -> 'recordId' = item.value -> 'recordId'
          and restored.value -> 'recordTypeId' = item.value -> 'recordTypeId'
      )
    loop
      perform vortex_record.complete_relationship_total_parent_internal(parent_plan);
    end loop;
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
      into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id;
    perform vortex_record.append_record_activity_internal(
      p_activity_id, 'restore_record', subject_ids, array[]::uuid[], 'completed'
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_restore', p_command_id,
      pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', restored_revision,
        'unrestoredLinkCount', deletion_plan -> 'unrestoredLinkCount'),
      'Protected record restore receipt is stale'
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = (context_value ->> 'organizationId')::uuid
        and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
        and effect.command_id = p_command_id
      order by effect.effect_sequence
    loop
      select (revision.value ->> 'concurrencyNumber')::bigint into strict current_revision
      from pg_catalog.jsonb_array_elements(preparation -> 'records') as prepared(value)
      join pg_catalog.jsonb_array_elements(revisions) as revision(value)
        on revision.value ->> 'recordKey' = prepared.value ->> 'recordKey'
      where (prepared.value ->> 'recordTypeId')::uuid = effect_row.record_type_id
        and (prepared.value ->> 'recordId')::uuid = effect_row.record_id;
      if exists (
        select 1 from vortex_record.storage_catalogue as storage
        where storage.storage_contract_id = effect_row.storage_contract_id
          and storage.storage_scope = 'application_contained'
      ) then
        begin
          notice_sequence := pg_catalog.nextval(
            'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
          );
          perform vortex_platform.publish_change_notice(
            effect_row.organization_id, effect_row.application_root_id,
            effect_row.record_type_id, effect_row.record_id, current_revision,
            'changed', notice_sequence, notice_sequence,
            (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record restore notice failed: [%] %', sqlstate, sqlerrm;
        end;
      else
        perform vortex_record.bump_record_data_version_internal(
          effect_row.organization_id, effect_row.storage_contract_id, null
        );
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'unrestoredLinkCount', deletion_plan -> 'unrestoredLinkCount',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, false
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
      loaded := (vortex_record.read_record(
        p_record_type_id, (receipt_claim -> 'result' ->> 'recordId')::uuid
      )) -> 'record';
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
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
      installation := vortex_definition.read_current_active_installation();
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
      perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
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
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
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
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id,
      pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', updated_concurrency_number),
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_platform.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_platform.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_platform.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_platform.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private lifecycle implementation reached only through apply_record_changes. Delete claims, traverses and finalises in two calls within one request transaction; restore and ownership transfer retain their own receipt, Activity and Event handling.';

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  original_context_value jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  copy_plan jsonb;
  preview_installation jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  storage_change jsonb;
  prepared_relationship jsonb;
  prepared_relationships jsonb;
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
  notice_sequence bigint;
  named_relationship_subject_saved boolean := false;
  named_action_receipt_pending boolean := false;
  named_action_receipt_subject_write boolean := false;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
  classification_value jsonb;
  delete_effect record;
  offboarding_scope record;
  offboarding_transfer jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership', 'settings')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- An account offboarding transfer of a retained row or of a detached installation's record has
  -- its own facts and the accounts.manage authority of the offboarding inventory, rechecked here
  -- for every record against the access version the inventory was disclosed at.
  if p_operation = 'transfer_ownership'
    and pg_catalog.jsonb_typeof(p_mutations) = 'array'
    and pg_catalog.jsonb_array_length(p_mutations) = 1
    and p_mutations -> 0 ->> 'kind' = 'offboarding_transfer' then
    offboarding_transfer := p_mutations -> 0;
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'expectedAccessVersion') is distinct from 'number'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'sourceOrganizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'targetId') is distinct from 'string' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    select authorized.* into strict offboarding_scope
    from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
    if offboarding_scope.access_version
      is distinct from (offboarding_transfer ->> 'expectedAccessVersion')::bigint then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
    end if;
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      offboarding_transfer ->> 'targetKind', (offboarding_transfer ->> 'targetId')::uuid,
      p_activity_id, p_occurrence_id,
      (offboarding_transfer ->> 'sourceOrganizationAccountId')::uuid
    );
  end if;

  -- Every lifecycle write, including the delete traversal and its finalisation,
  -- enters here. Delete preparation uses null mutations; calculated parent
  -- mutations complete the same receipt within the same request transaction.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    result_value := vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
    if p_operation = 'delete' and result_value ->> 'outcome' = 'deleted'
      and result_value ->> 'replayed' = 'false' then
      context_value := vortex_access.validated_human_request_context();
      -- Publish once per deleted record after totals, Activity, Events and the
      -- receipt are complete. Replays and preparations publish nothing.
      for delete_effect in
        select effect.*
        from vortex_record.record_lifecycle_command_effects as effect
        join vortex_record.storage_catalogue as storage
          on storage.storage_contract_id = effect.storage_contract_id
        where effect.command_id = p_command_id
          and effect.organization_id = (context_value ->> 'organizationId')::uuid
          and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
          and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
          and effect.effect_kind = 'soft_deleted'
          and storage.storage_scope = 'application_contained'
        order by effect.effect_sequence
      loop
        begin
          notice_sequence := pg_catalog.nextval(
            'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
          );
          perform vortex_platform.publish_change_notice(
            delete_effect.organization_id, delete_effect.application_root_id,
            delete_effect.record_type_id, delete_effect.record_id,
            delete_effect.post_concurrency_number, 'deleted',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record delete notice failed: [%] %', sqlstate, sqlerrm;
        end;
      end loop;
    end if;
    return result_value;
  end if;

  -- Settings use the same command entry and one settings mutation. Their
  -- physical row belongs to Identity, so the protected implementation below
  -- performs the specialised write and the common Record effects once.
  if p_operation = 'settings' then
    if p_action is not null
      or p_selected_group_id is not null
      or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or (p_mutations -> 0 ->> 'kind') is distinct from 'settings'
      or (p_mutations -> 0) - array['kind', 'values']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'values') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_settings_record_changes_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values,
      p_mutations -> 0 -> 'values', p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
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
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
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
  original_context_value := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'organizationAccountId', actor_id_value,
    'correlationId', correlation_id_value
  );

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations, action_context
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
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed BeforeSave flow the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasBeforeSaveFlows')::boolean, false) then
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
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
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
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
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
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs, action_context
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
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
      perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
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
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if creation_count = 0 then
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id,
        pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', p_expected_concurrency_number),
        'Named action receipt is stale'
      );
    else
      named_action_receipt_pending := true;
    end if;
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, false
    );
  else
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim -> 'result' ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := (vortex_record.read_record(
        p_record_type_id, (receipt_claim -> 'result' ->> 'recordId')::uuid
      )) -> 'record';
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  -- Recheck the ordinary operation at persistence. A named action has its own authority.
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (not action_mode
      and not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false)) then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
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
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
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
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
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
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null, null::jsonb
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        -- Only a record of this application's own Module uses preview-owner authority.
        -- Borrowed records and live projections still need the builder's current permission.
        if preview_installation is not null
          and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
          and exists (
            select 1 from vortex_definition.roots as root
            where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
              and root.owner_application_root_id = application_root_id_value
          ) then
          target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
        else
          if pg_catalog.jsonb_array_length(
            target_loaded #> '{declaration,requiredPermissions}'
          ) = 0 then
            perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
            );
          end if;
          target_decision := vortex_access.evaluate_organization_record_access_internal(
            pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
              '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
          );
        end if;
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place means no writer orders them on its own.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

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
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
        else
          activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if action_mode then
      mutation := vortex_record.prepare_named_action_record_change_internal(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids,
        action_owner_kind, action_owner_id, action_release_revision, action_id_value
      );
    else
      mutation := vortex_record.prepare_record_change_internal(
        p_record_type_id, p_record_id, p_expected_concurrency_number,
        value_final_values, value_submitted_field_ids
      );
    end if;

    if mutation ->> 'outcome' = 'allowed' then
      storage_change := mutation -> 'storageChange';
      prepared_relationships := '[]'::jsonb;
      if preview_installation is null and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
        perform vortex_record.bump_record_data_version_internal(
          organization_id_value, (meta ->> 'storageContractId')::uuid,
          case when meta ->> 'storageScope' = 'application_contained'
            then application_root_id_value else null end
        );
      end if;
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        prepared_relationship := vortex_record.prepare_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', false
        );
        storage_change := pg_catalog.jsonb_set(storage_change, '{values}',
          (storage_change -> 'values') || pg_catalog.jsonb_build_object(
            prepared_relationship ->> 'column', prepared_relationship -> 'value'
          )
        );
        prepared_relationships := prepared_relationships ||
          pg_catalog.jsonb_build_array(prepared_relationship);
      end loop;
      -- Scalar and link values share the same tuple write and revision. Edge
      -- identities were locked during preparation and are replaced together.
      perform vortex_record.apply_record_storage_changes_internal(
        pg_catalog.jsonb_build_array(storage_change)
      );
      perform vortex_record.apply_relationship_edges_internal(prepared_relationships);
      named_relationship_subject_saved := action_mode
        and preview_installation is null
        and meta ->> 'storageScope' = 'application_contained';
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'create_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;
  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  perform vortex_platform.attach_record_files_internal(p_record_type_id, saved_record_id, meta -> 'recordType', final_values);
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  elsif preview_installation is null then
    activity_time := vortex_record.append_record_activity_internal(p_activity_id, case when p_operation = 'create' then 'create_record' else 'update_record' end, array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_platform.append_record_occurrences(
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
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  if action_mode and creation_count > 0 then
    named_action_receipt_pending := true;
    named_action_receipt_subject_write := true;
  else
    perform vortex_record.complete_command_receipt_internal(
      receipt_kind, effective_command_id,
      pg_catalog.jsonb_build_object('recordId', saved_record_id, 'concurrencyNumber', saved_concurrency_number),
      'Record save receipt is stale'
    );
  end if;

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := (vortex_record.read_record(p_record_type_id, saved_record_id)) -> 'record';
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    if preview_installation is null
      and p_operation = 'update'
      and (
        value_final_values <> '{}'::jsonb
        or pg_catalog.jsonb_array_length(relationship_changes) > 0
      )
      and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          saved_record_id, saved_concurrency_number, 'changed',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception
        when others then
          -- Invalidation is advisory; a lost notice must not refuse the save.
          null;
      end;
    end if;
    return result_value;
  end if;

  return vortex_record.complete_named_action_changes_internal(
    action_owner_kind, action_owner_id, action_release_revision,
    action_id_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, result_value, subject_written,
    action_context, action_declared_occurrence_ids, creation_count,
    create_targets, action_creations, organization_id_value,
    action_creation_occurrence_ids, original_context_value, copy_plan,
    action_parents, preparation_value, named_action_receipt_pending,
    named_action_receipt_subject_write, effective_command_id, saved_record_id,
    saved_concurrency_number, application_root_id_value, correlation_id_value,
    named_relationship_subject_saved
  );
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one command receipt (a preview command carries its own preview-scoped id) and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

create or replace function vortex_record.apply_record_storage_changes_internal(
  p_changes jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  storage_group record;
  storage_row vortex_record.storage_catalogue%rowtype;
  column_names text;
  source_columns text;
  assignments text;
  result_value jsonb := '[]'::jsonb;
  written jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values'])
      or item.value - array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values']::text[] <> '{}'::jsonb
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
      or pg_catalog.jsonb_typeof(item.value -> 'values') is distinct from 'object'
      or (item.value -> 'values') ?| array['organisation_id', 'record_id']
      or (item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb and (
        pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') <> 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;

  -- Callers have checked current and proposed authority, field policy and all
  -- relationship constraints. Storage identities come from those preparations;
  -- the request role cannot call this primitive or supply a physical table.
  for storage_group in
    select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      pg_catalog.jsonb_agg(item.value order by item.value ->> 'recordId') as changes
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by (item.value ->> 'storageContractId')::uuid
    order by (item.value ->> 'storageContractId')::uuid
  loop
    select storage.* into strict storage_row
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = storage_group.storage_contract_id;
    if storage_row.physical_schema_token is distinct from 'record_data'
      or storage_row.physical_table_token is null then
      raise exception using errcode = '55000', message = 'Record storage is unavailable';
    end if;
    select
      pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('source.%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('%I = source.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
        filter (where attribute.attname not in ('organisation_id', 'record_id'))
    into column_names, source_columns, assignments
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
    )) and attribute.attnum > 0 and not attribute.attisdropped;
    if column_names is null or exists (
      select 1
      from pg_catalog.jsonb_array_elements(storage_group.changes) as item(value)
      cross join lateral pg_catalog.jsonb_object_keys(item.value -> 'values') as supplied(name)
      where not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
          '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
        )) and attribute.attnum > 0 and not attribute.attisdropped
          and attribute.attname = supplied.name
      )
    ) then
      raise exception using errcode = '55000', message = 'Record storage columns disagree with the prepared change';
    end if;

    -- MERGE gives creates and updates of the same storage table one physical
    -- write statement. A missing update or an existing create matches neither
    -- permitted branch, so the count check rejects the entire transaction.
    execute pg_catalog.format(
      'with written as (
        merge into %1$I.%2$I as stored
        using (
          select (item.value ->> ''expectedConcurrencyNumber'')::bigint as expected_revision,
            candidate.*
          from pg_catalog.jsonb_array_elements($1) as item(value)
          left join %1$I.%2$I as current_record
            on current_record.organisation_id = $2
            and current_record.record_id = (item.value ->> ''recordId'')::uuid
          cross join lateral pg_catalog.jsonb_populate_record(null::%1$I.%2$I,
            coalesce(pg_catalog.to_jsonb(current_record), ''{}''::jsonb)
              || (item.value -> ''values'')
              || pg_catalog.jsonb_build_object(
                ''organisation_id'', $2, ''record_id'', item.value -> ''recordId'',
                ''concurrency_number'', coalesce((item.value ->> ''expectedConcurrencyNumber'')::bigint, 0) + 1,
                ''updated_at'', pg_catalog.statement_timestamp(), ''updated_by'', $3
              )
          ) as candidate
        ) as source
        on stored.organisation_id = $2 and stored.record_id = source.record_id
        when matched and source.expected_revision is not null
          and stored.concurrency_number = source.expected_revision
          then update set %3$s
        when not matched and source.expected_revision is null
          then insert (%4$s) values (%5$s)
        returning pg_catalog.jsonb_build_object(
          ''recordId'', stored.record_id, ''storageContractId'', stored.storage_contract_id,
          ''concurrencyNumber'', stored.concurrency_number
        ) as result
      ) select coalesce(pg_catalog.jsonb_agg(written.result), ''[]''::jsonb) from written',
      storage_row.physical_schema_token, storage_row.physical_table_token,
      assignments, column_names, source_columns
    ) into written using storage_group.changes, (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid;
    if pg_catalog.jsonb_array_length(written) <> pg_catalog.jsonb_array_length(storage_group.changes) then
      raise exception using errcode = '40001', message = 'Record storage change revision is stale';
    end if;
    result_value := result_value || written;
  end loop;
  return result_value;
end
$function$;

alter function vortex_record.apply_record_storage_changes_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_record_storage_changes_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_record_storage_changes_internal(jsonb) is
  'Private physical record mutation primitive: merges already-authorized changes with one write per storage table, preserving unsupplied columns and rejecting stale revisions atomically.';

create or replace function vortex_record.apply_relationship_edges_internal(p_changes jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  organization_id_value uuid;
begin
  organization_id_value := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Relationship changes are invalid';
  end if;

  -- Every source is one declared fixed link. The shared participant locks and
  -- target eligibility checks have already run in relationship preparation.
  merge into vortex_record.relationship_edges as edge
  using (
    select (item.value ->> 'relationshipId')::uuid as relationship_id,
      (item.value ->> 'sourceStorageContractId')::uuid as source_storage_contract_id,
      (item.value ->> 'sourceRecordId')::uuid as source_record_id,
      (item.value ->> 'sourceApplicationRootId')::uuid as source_application_root_id,
      (item.value ->> 'targetStorageContractId')::uuid as target_storage_contract_id,
      (item.value ->> 'targetRecordId')::uuid as target_record_id,
      (item.value ->> 'targetApplicationRootId')::uuid as target_application_root_id
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
  ) as change
  on edge.relationship_id = change.relationship_id
    and edge.from_organisation_id = organization_id_value
    and edge.from_storage_contract_id = change.source_storage_contract_id
    and edge.from_record_id = change.source_record_id
  when matched and change.target_record_id is null then delete
  when matched then update set
    to_storage_contract_id = change.target_storage_contract_id,
    to_record_id = change.target_record_id,
    from_application_root_id = change.source_application_root_id,
    to_application_root_id = change.target_application_root_id
  when not matched and change.target_record_id is not null then insert (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    change.relationship_id, organization_id_value, organization_id_value,
    change.source_application_root_id, change.target_application_root_id,
    change.source_storage_contract_id, change.source_record_id,
    change.target_storage_contract_id, change.target_record_id
  );

  -- Check the final set too: two newly supplied links must not each pass a
  -- check against the old graph and claim the same one-to-one target.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    join vortex_record.relationship_edges as edge
      on edge.relationship_id = (item.value ->> 'relationshipId')::uuid
      and edge.to_organisation_id = organization_id_value
      and edge.to_storage_contract_id = (item.value ->> 'targetStorageContractId')::uuid
      and edge.to_record_id = (item.value ->> 'targetRecordId')::uuid
      and edge.from_storage_contract_id = (item.value ->> 'sourceStorageContractId')::uuid
    where item.value ->> 'cardinality' = 'one_to_one'
    group by item.value
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
  end if;
end
$function$;

alter function vortex_record.apply_relationship_edges_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_relationship_edges_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_relationship_edges_internal(jsonb) is
  'Private set-based edge writer: applies prepared fixed-link replacements in one MERGE and checks one-to-one cardinality on the final graph.';

create or replace function vortex_record.apply_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared jsonb;
begin
  prepared := vortex_record.prepare_relationship_total_parent_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number, p_final_values,
    vortex_record.relationship_total_catalogue_internal()
  );
  if prepared is null then return; end if;
  perform vortex_record.apply_record_storage_changes_internal(pg_catalog.jsonb_build_array(prepared -> 'storageChange'));
  perform vortex_record.complete_relationship_total_parent_internal(prepared);
end
$function$;
alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;


alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) is
  'Applies protected generated parent totals and calculations with the actual saved revision, Activity and standard Events in the original transaction. Live application-contained writes publish an advisory content-free notice for the actual saved Record; other scopes and previews retain their existing invalidation behavior.';

create or replace function vortex_record.apply_settings_record_changes_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
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
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  receipt_claim jsonb;
  access_result jsonb;
  projection jsonb;
  event_result jsonb;
  correlation_id_value uuid;
  application_root_id_value uuid;
  notice_sequence bigint;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id is null
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    if p_command_id is not null then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_platform_system_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_record.decide_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' = 'completed' then
      projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
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
    if receipt_claim ->> 'status' is distinct from 'none' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'reasonCode', 'command_pending',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'reasonCode', 'record_revision_conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber',
      'correlationId', correlation_id_value
    );
  end if;

  access_result := vortex_access.change_organization_settings_record_internal(
    p_record_id, p_expected_concurrency_number, core_values, extension_values
  );
  if access_result ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return access_result || pg_catalog.jsonb_build_object(
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_conflict'),
      'correlationId', correlation_id_value
    );
  end if;
  if access_result ->> 'outcome' <> 'saved' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(access_result ->> 'reasonCode', 'access_refused'),
      'correlationId', correlation_id_value
    );
  end if;

  perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[p_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (meta ->> 'storageContractId')::uuid,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Organization settings Event append failed';
  end if;

  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id,
    pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', (access_result ->> 'concurrencyNumber')::bigint),
    'Organization settings record save receipt is stale'
  );
  projection := (vortex_record.read_record(p_record_type_id, p_record_id)) -> 'record';
  if projection ->> 'outcome' <> 'allowed' then
    raise exception using errcode = '55000',
      message = 'Saved organisation settings projection is unavailable';
  end if;
  begin
    notice_sequence := pg_catalog.nextval(
      'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
    );
    perform vortex_platform.publish_change_notice(
      p_record_id, application_root_id_value, p_record_type_id,
      p_record_id, (access_result ->> 'concurrencyNumber')::bigint, 'changed',
      notice_sequence, notice_sequence, correlation_id_value
    );
  exception when others then
    -- Invalidation is advisory after the protected settings change completes,
    -- but its failure is logged with the cause so a stale view can be diagnosed.
    raise warning 'RECORD_INVALIDATION_FAILED settings record %: % %',
      p_record_id, sqlstate, sqlerrm;
  end;
  return pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', 'pending',
    'replayed', false
  );
exception
  when serialization_failure or deadlock_detected then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save conflicted: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'database_conflict_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
  when no_data_found or too_many_rows or insufficient_privilege or check_violation
    or object_not_in_prerequisite_state or invalid_text_representation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Organization settings record save refused: % (%)', failure_message, failure_sqlstate;
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'database_refused_' || failure_sqlstate,
      'correlationId', correlation_id_value
    );
end
$function$;
alter function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) owner to vortex_record_adapter;


revoke all on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Internal settings change reached only through apply_record_changes: rechecks the installed system projection, protected permission and revision, then writes once with one Activity, Event and change notice.';

alter function vortex_record.apply_settings_record_changes_internal(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
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
  tenant_id_value uuid;
  actor_id_value uuid;
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  tenant_id_value := (context_value ->> 'tenantId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;

  -- The command id is claimed as pending (no result yet). A claim that finds an
  -- existing receipt locks it and classifies it; a replay-only read classifies
  -- without inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      command_id, organization_id, tenant_id, actor_id, command_kind
    ) values (
      p_command_id, organization_id_value, tenant_id_value, actor_id_value, p_command_kind
    )
    on conflict (command_id) do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Command receipt was released while it was claimed';
    end if;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  -- A command id replays only inside the scope that stored it.
  if receipt.organization_id is distinct from organization_id_value
    or receipt.tenant_id is distinct from tenant_id_value
    or receipt.actor_id is distinct from actor_id_value
    or receipt.command_kind is distinct from p_command_kind then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.result is null then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'result', receipt.result
  );
end
$function$;

alter function vortex_record.claim_command_receipt_internal(text,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the command id as pending, or classifies its receipt as identity_conflict (stored under another organisation, tenant, actor or command kind), pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';

create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_result jsonb,
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
  if p_result is null then
    raise exception using errcode = '22023', message = 'Command result must not be null';
  end if;
  context_value := vortex_access.validated_human_request_context();
  update vortex_record.command_receipts as stored
  set result = p_result
  where stored.command_id = p_command_id
    and stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.tenant_id = (context_value ->> 'tenantId')::uuid
    and stored.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and stored.command_kind = p_command_kind
    and stored.result is null;
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

alter function vortex_record.complete_command_receipt_internal(text,uuid,jsonb,text) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) is
  'Completes the request scope''s pending command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';

create or replace function vortex_record.complete_named_action_changes_internal(
  action_owner_kind text,
  action_owner_id uuid,
  action_release_revision bigint,
  action_id_value uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  result_value jsonb,
  subject_written boolean,
  action_context jsonb,
  action_declared_occurrence_ids jsonb,
  creation_count integer,
  create_targets jsonb,
  action_creations jsonb,
  organization_id_value uuid,
  action_creation_occurrence_ids jsonb,
  original_context_value jsonb,
  copy_plan jsonb,
  action_parents jsonb,
  preparation_value jsonb,
  named_action_receipt_pending boolean,
  named_action_receipt_subject_write boolean,
  effective_command_id uuid,
  saved_record_id uuid,
  saved_concurrency_number bigint,
  application_root_id_value uuid,
  correlation_id_value uuid,
  named_relationship_subject_saved boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  event_loaded jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  public_created_records jsonb := '{}'::jsonb;
  created_record_tuples jsonb := '[]'::jsonb;
  first_created_record_tuples jsonb := '[]'::jsonb;
  inserted_value jsonb;
  final_created_tuple jsonb;
  saved_tuple jsonb;
  seen_created_ordinals integer[] := array[]::integer[];
  seen_created_ids uuid[] := array[]::uuid[];
  created_ordinal integer;
  created_concurrency_number bigint;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  loaded jsonb;
  target_record_id uuid;
  notice_sequence bigint;
  changed_field_ids uuid[];
  event_result jsonb;
begin
  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(action_declared_occurrence_ids)
        with ordinality expected(value, ordinal) using (ordinal)
      where pg_catalog.jsonb_typeof(appended.value) is distinct from 'object'
        or pg_catalog.jsonb_typeof(appended.value -> 'occurrenceId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(
          appended.value ->> 'occurrenceId', 'uuid'
        ), true)
        or (appended.value ->> 'occurrenceId')::uuid is distinct from
          (expected.value #>> '{}')::uuid
    ) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
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

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
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
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
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
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- Reauthorize the complete new graph before any created-row Activity or
    -- Event is visible. This barrier is intentionally whole-command, not per row.
    first_created_record_tuples :=
      vortex_record.authorize_created_records_for_command_internal(
        action_creations, created_records, original_context_value
      );
    if pg_catalog.jsonb_typeof(first_created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(first_created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action creation authority result is incomplete';
    end if;

    -- Append each created-row Activity and its standard Event only after the
    -- complete set passed ordinary CREATE authorization.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'execute_named_action', array[created_record_id]::uuid[], changed_field_ids, 'completed');
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_platform.append_record_occurrences(
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
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
      if pg_catalog.jsonb_typeof(event_result -> 0) is distinct from 'object'
        or event_result -> 0 ->> 'occurrenceId' is distinct from occurrence_id_value::text then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
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

  if creation_count > 0 then
    -- Re-load and reauthorize the entire graph after every mandatory created-row,
    -- copy and parent effect. These actual final target tuples drive both receipt
    -- completion and the narrow advisory created-notice attempts below.
    created_record_tuples := vortex_record.authorize_created_records_for_command_internal(
      action_creations, created_records, original_context_value
    );
    if pg_catalog.jsonb_typeof(created_record_tuples) is distinct from 'array' then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    if pg_catalog.jsonb_array_length(created_record_tuples) is distinct from creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation authority is incomplete';
    end if;
    for final_created_tuple in
      select item.value
      from pg_catalog.jsonb_array_elements(created_record_tuples) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(final_created_tuple) is distinct from 'object'
        or not (final_created_tuple ?& array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ])
        or final_created_tuple - array[
          'ordinal', 'recordId', 'concurrencyNumber', 'organizationId', 'applicationRootId',
          'moduleRootId', 'recordTypeId', 'storageContractId', 'moduleReleaseRevision',
          'storageScope', 'correlationId', 'eligible'
        ]::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'ordinal') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'ordinal', 'integer'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'concurrencyNumber') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'concurrencyNumber', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'organizationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'organizationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') not in ('string', 'null')
        or (pg_catalog.jsonb_typeof(final_created_tuple -> 'applicationRootId') = 'string'
          and coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'applicationRootId', 'uuid'), true))
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleRootId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleRootId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'recordTypeId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'recordTypeId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageContractId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'storageContractId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'moduleReleaseRevision') is distinct from 'number'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'moduleReleaseRevision', 'bigint'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'storageScope') is distinct from 'string'
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'correlationId') is distinct from 'string'
        or coalesce(not pg_catalog.pg_input_is_valid(final_created_tuple ->> 'correlationId', 'uuid'), true)
        or pg_catalog.jsonb_typeof(final_created_tuple -> 'eligible') is distinct from 'boolean' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is malformed';
      end if;
      created_ordinal := (final_created_tuple ->> 'ordinal')::integer;
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      if created_ordinal < 0
        or created_ordinal = any (seen_created_ordinals)
        or created_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or created_record_id = any (seen_created_ids)
        or created_concurrency_number not between 1 and 9007199254740991
        or (final_created_tuple ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
        or (final_created_tuple ->> 'organizationId')::uuid is distinct from organization_id_value
        or (final_created_tuple ->> 'correlationId')::uuid is distinct from correlation_id_value
        or (final_created_tuple ->> 'storageScope') not in ('application_contained', 'organization_shared')
        or ((final_created_tuple ->> 'storageScope') = 'application_contained'
          and (final_created_tuple ->> 'applicationRootId')::uuid is distinct from application_root_id_value)
        or ((final_created_tuple ->> 'storageScope') = 'organization_shared'
          and final_created_tuple -> 'applicationRootId' is distinct from 'null'::jsonb)
        or (final_created_tuple ->> 'eligible')::boolean is distinct from
          ((final_created_tuple ->> 'storageScope') = 'application_contained') then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple is invalid';
      end if;
      inserted_value := created_records -> created_ordinal::text;
      saved_tuple := inserted_value -> '_savedTuple';
      if inserted_value is null
        or final_created_tuple -> 'recordId' is distinct from inserted_value -> 'recordId'
        or final_created_tuple -> 'organizationId' is distinct from saved_tuple -> 'organizationId'
        or final_created_tuple -> 'applicationRootId' is distinct from saved_tuple -> 'applicationRootId'
        or final_created_tuple -> 'moduleRootId' is distinct from saved_tuple -> 'moduleRootId'
        or final_created_tuple -> 'recordTypeId' is distinct from saved_tuple -> 'recordTypeId'
        or final_created_tuple -> 'storageContractId' is distinct from saved_tuple -> 'storageContractId'
        or final_created_tuple -> 'moduleReleaseRevision' is distinct from saved_tuple -> 'moduleReleaseRevision'
        or final_created_tuple -> 'storageScope' is distinct from saved_tuple -> 'storageScope'
        or final_created_tuple -> 'correlationId' is distinct from saved_tuple -> 'correlationId'
        or final_created_tuple -> 'eligible' is distinct from saved_tuple -> 'eligible' then
        raise exception using errcode = '55000',
          message = 'Named action final creation tuple changed';
      end if;
      seen_created_ordinals := pg_catalog.array_append(seen_created_ordinals, created_ordinal);
      seen_created_ids := pg_catalog.array_append(seen_created_ids, created_record_id);
      public_created_records := public_created_records || pg_catalog.jsonb_build_object(
        created_ordinal::text, pg_catalog.jsonb_build_object(
          'recordId', inserted_value -> 'recordId',
          'storageContractId', inserted_value -> 'storageContractId',
          'values', inserted_value -> 'values'
        )
      );
    end loop;
    if pg_catalog.cardinality(seen_created_ordinals) <> creation_count
      or pg_catalog.cardinality(seen_created_ids) <> creation_count then
      raise exception using errcode = '55000',
        message = 'Named action final creation set is incomplete';
    end if;

    if not named_action_receipt_pending then
      raise exception using errcode = '55000',
        message = 'Named action receipt completion is unavailable';
    end if;
    if named_action_receipt_subject_write then
      if saved_record_id is null
        or saved_record_id = '00000000-0000-0000-0000-000000000000'::uuid
        or saved_concurrency_number is null
        or saved_concurrency_number not between 1 and 9007199254740991 then
        raise exception using errcode = '55000',
          message = 'Named action receipt completion tuple is unavailable';
      end if;
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id,
        pg_catalog.jsonb_build_object('recordId', saved_record_id, 'concurrencyNumber', saved_concurrency_number),
        'Record save receipt is stale'
      );
    else
      perform vortex_record.complete_command_receipt_internal(
        'named_action', effective_command_id,
        pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', p_expected_concurrency_number),
        'Named action receipt is stale'
      );
    end if;
    named_action_receipt_pending := false;
  end if;

  -- Only the new created-row notice attempt is advisory. All tuple and context
  -- validation above is outside this per-tuple catch; allocation, safe sequence
  -- validation and exact publication share one narrow failure boundary.
  for final_created_tuple in
    select item.value from pg_catalog.jsonb_array_elements(created_record_tuples) item(value)
  loop
    if (final_created_tuple ->> 'eligible')::boolean then
      created_record_id := (final_created_tuple ->> 'recordId')::uuid;
      created_concurrency_number := (final_created_tuple ->> 'concurrencyNumber')::bigint;
      begin
        notice_sequence := pg_catalog.nextval(
          'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
        );
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Created Record notice sequence is unavailable';
        end if;
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value,
          (final_created_tuple ->> 'recordTypeId')::uuid,
          created_record_id, created_concurrency_number, 'created',
          notice_sequence, notice_sequence, correlation_id_value
        );
      exception when others then
        null;
      end;
    end if;
  end loop;
  if named_relationship_subject_saved then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        organization_id_value, application_root_id_value, p_record_type_id,
        saved_record_id, saved_concurrency_number, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Invalidation is advisory after the protected named action is complete.
      null;
    end;
  end if;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', public_created_records);
end
$function$;

alter function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean)
  to vortex_record_adapter;

comment on function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean) is
  'Private terminal step of apply_record_changes: preserves declared Events, ordered creations and edges, whole-graph authorization, parent effects, receipt completion and advisory notices in the caller transaction and restricted record role.';

create or replace function vortex_record.complete_relationship_total_parent_internal(p_prepared jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  snapshot jsonb := p_prepared -> 'snapshot';
  saved_record_id uuid := (p_prepared ->> 'recordId')::uuid;
  new_revision bigint := (p_prepared ->> 'concurrencyNumber')::bigint;
  changed_field_ids uuid[];
  preview_installation jsonb;
  pending_exact_notice boolean := false;
  notice_sequence bigint;
  event_result jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  select pg_catalog.array_agg(value::uuid) into changed_field_ids
  from pg_catalog.jsonb_array_elements_text(p_prepared -> 'changedFieldIds') as field(value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and snapshot #>> '{recordType,storageScope}' = 'application_contained' then
    pending_exact_notice := true;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (snapshot ->> 'storageContractId')::uuid,
      case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'update_record', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', (p_prepared ->> 'recordTypeId')::uuid
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
  if pending_exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        (p_prepared ->> 'recordTypeId')::uuid, saved_record_id, new_revision, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the parent write.
        raise warning 'Generated record notice failed: [%] %', sqlstate, sqlerrm;
    end;
  end if;
end
$function$;

alter function vortex_record.complete_relationship_total_parent_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_relationship_total_parent_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_relationship_total_parent_internal(jsonb) is
  'Appends the Activity, standard Event and invalidation for a protected generated-field update after the shared record storage writer has applied it.';

create or replace function vortex_record.prepare_record_create_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  physical_values jsonb := '{}'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  storage_change jsonb;
  preview_installation jsonb;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object')
      or (preview_installation is not null
        and (preview_installation ->> 'outcome' = 'refused'
          or meta -> 'recordType' ? 'systemProjection')) then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(case when preview_installation is null
          then vortex_record.allocate_reference_number_internal(
            (context_value ->> 'organizationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, app_scope, field_item -> 'settings'
          )
          else vortex_record.allocate_preview_reference_number_internal(
            (preview_installation ->> 'previewInstallationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, field_item -> 'settings'
          ) end);
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      physical_values := physical_values || pg_catalog.jsonb_build_object(
        column_value ->> 'token', input_value
      );
    end loop;

    storage_change := pg_catalog.jsonb_build_object(
        'storageContractId', meta -> 'storageContractId', 'recordId', record_id_value,
        'expectedConcurrencyNumber', null,
        'values', physical_values || pg_catalog.jsonb_build_object(
          'module_root_id', meta -> 'moduleRootId', 'record_type_id', p_record_type_id,
          'storage_contract_id', meta -> 'storageContractId', 'application_root_id', app_scope,
          'definition_revision', meta -> 'moduleReleaseRevision',
          'owner_organisation_account_id', owner_account_id, 'owner_group_id', owner_group_id,
          'lifecycle_state', 'active', 'created_at', pg_catalog.statement_timestamp(),
          'created_by', context_value -> 'organizationAccountId'
        )
    );

    -- The canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here before any edge identity, so a multi-link create uses the
    -- same lock order as the update writer. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        edge_changes := edge_changes || pg_catalog.jsonb_build_array(
          vortex_record.prepare_relationship_value_internal(
            p_record_type_id, record_id_value,
            (relationship_value ->> 'relationshipId')::uuid,
            final_values -> pg_catalog.lower(field_id_value::text), false
          )
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'recordTypeId', p_record_type_id,
      'recordId', record_id_value, 'values', final_values,
      'submittedFieldIds', pg_catalog.to_jsonb(p_submitted_field_ids),
      'storageChange', storage_change, 'edgeChanges', edge_changes
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.prepare_record_create_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid) is
  'Private create preparation: derives trusted scope, ownership and generated references, validates typed fields and relationship targets, and returns storage and edge mutations without inserting the record.';

create or replace function vortex_record.complete_record_create_internal(p_prepared jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  p_record_type_id uuid := (p_prepared ->> 'recordTypeId')::uuid;
  record_id_value uuid := (p_prepared ->> 'recordId')::uuid;
  p_submitted_field_ids uuid[];
  meta jsonb;
  context_value jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  refusal_reason text;
  notice_sequence bigint;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
  context_value := meta -> 'context';
  preview_installation := vortex_record.read_current_preview_installation_internal();
  select coalesce(pg_catalog.array_agg(item.value::uuid), array[]::uuid[])
  into p_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(p_prepared -> 'submittedFieldIds') item(value);
  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'create', record_id_value, null, null::jsonb
  );
  if loaded ->> 'outcome' <> 'loaded' then
    refusal_reason := 'record_unavailable';
    raise exception using errcode = 'P4020', message = refusal_reason;
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  if preview_installation is null then
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', record_id_value, facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      refusal_reason := 'access_refused';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  else
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if preview_bounds is null then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    bounds := preview_bounds;
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
  foreach submitted_id in array p_submitted_field_ids loop
    if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      refusal_reason := 'field_not_changeable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
  end loop;

  if preview_installation is null and meta ->> 'storageScope' = 'application_contained' then
    begin
      notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid, p_record_type_id,
        record_id_value, 1, 'created', notice_sequence, notice_sequence,
        (context_value ->> 'correlationId')::uuid
      );
    exception when others then
      raise warning 'Record create notice failed: [%] %', sqlstate, sqlerrm;
    end;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', record_id_value,
    'concurrencyNumber', 1, 'values', p_prepared -> 'values'
  );
end
$function$;
alter function vortex_record.complete_record_create_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_create_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_create_internal(jsonb) is
  'Private create finalisation: evaluates create authority and submitted field bounds over the persisted proposed graph, raises a refusal to roll back the set, and publishes its advisory invalidation.';

create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  prepared jsonb;
begin
  prepared := vortex_record.prepare_record_create_internal(
    p_record_type_id, p_final_values, p_submitted_field_ids, p_selected_group_id
  );
  if prepared ->> 'outcome' is distinct from 'prepared' then
    return prepared;
  end if;
  perform vortex_record.apply_record_storage_changes_internal(
    pg_catalog.jsonb_build_array(prepared -> 'storageChange')
  );
  perform vortex_record.apply_relationship_edges_internal(prepared -> 'edgeChanges');
  return vortex_record.complete_record_create_internal(prepared);
exception
  when sqlstate 'P4020' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', sqlerrm);
  when no_data_found or too_many_rows or object_not_in_prerequisite_state then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
end
$function$;
alter function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) is
  'Private single-create composition of the shared set preparation, storage write, edge write and authority finalisation, with rollback on refusal.';

create or replace function vortex_record.named_action_deleted_subject_replay_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid
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
  digest_value bytea;
  lifecycle_command_id uuid;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'tasks'
    ) item(value)
    where item.value ->> 'type' = 'record.delete'
  ) then
    return null;
  end if;
  -- The deleting action's lifecycle receipt carries the identity derived from
  -- the action's command id; the two receipts cannot share one command id.
  digest_value := pg_catalog.substring(pg_catalog.sha256(
    pg_catalog.convert_to('record.delete:' || p_command_id::text, 'UTF8')
  ), 1, 16);
  lifecycle_command_id := pg_catalog.encode(
    pg_catalog.set_byte(pg_catalog.set_byte(
      digest_value, 6, (pg_catalog.get_byte(digest_value, 6) & 15) | 80
    ), 8, (pg_catalog.get_byte(digest_value, 8) & 63) | 128), 'hex'
  )::uuid;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_delete', lifecycle_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'completed' then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'recordId', receipt_claim -> 'result' -> 'recordId',
    'concurrencyNumber', receipt_claim -> 'result' -> 'concurrencyNumber',
    'values', '{}'::jsonb,
    'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
    'backgroundDelivery', 'pending',
    'replayed', true
  );
end
$function$;

alter function vortex_record.named_action_deleted_subject_replay_internal(uuid,text,uuid,bigint,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid
) is
  'Private named-action step: for an installed action that declares record.delete, reports the stored outcome of the completed protected delete carrying the same command identity and revision (the deleted revision and no values), because a deleted subject cannot be projected. Returns null otherwise.';

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
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
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
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
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
    projection := (vortex_record.read_record(
      p_record_type_id, (receipt_claim -> 'result' ->> 'recordId')::uuid
    )) -> 'record';
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
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- Ordinary saves require the explicit operation; named actions use their own preparation.
  if not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false) then
    raise log 'Record save preparation refused: standard operation % is not declared', p_operation;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'correlationId', correlation_id_value
    );
  end if;
  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_platform_system_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
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
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- The owning Module release's BeforeSave flows for this record type, run by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
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
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.prepare_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  physical_values jsonb := '{}'::jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_entry ->> 'token', entry_value
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'values', values_value,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', loaded #> '{recordTypeMeta,storageContractId}',
      'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object(
        'definition_revision', loaded -> 'moduleReleaseRevision'
      )
    )
  );
end
$function$;
alter function vortex_record.prepare_record_change_internal(uuid,uuid,bigint,jsonb,uuid[]) owner to vortex_record_adapter;


alter function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[]) is
  'Private record update preparation. Locks the current revision, checks current and proposed authority and field bounds, and returns the storage mutation and permitted projection for the set writer.';

create or replace function vortex_record.prepare_record_delete_closure_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  relationship_value jsonb;
  source_field_id uuid;
  on_parent_delete text;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  dependent_plan jsonb;
  edge_change jsonb;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number, null::jsonb
  );
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by the fixed record loader.
  for incoming in
    select edge.*
    from vortex_record.relationship_edges as edge
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into strict source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    -- Preview-only relationships have no installed mapping. The edge's exact source
    -- storage declares the field and deletion policy, just as it declares edge integrity.
    select relationship.value into strict relationship_value
    from pg_catalog.jsonb_array_elements(
      source_catalogue.record_type_definition -> 'relationships'
    ) as relationship(value)
    where (relationship.value ->> 'relationshipId')::uuid = incoming.relationship_id;
    source_field_id := (relationship_value ->> 'fromFieldId')::uuid;
    on_parent_delete := relationship_value ->> 'onParentDelete';
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when on_parent_delete = 'empty_optional' then 'update'
      when on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise warning 'Delete relationship declaration unavailable: [%] %', sqlstate, sqlerrm;
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;
    if (source_meta ->> 'storageContractId')::uuid is distinct from
      incoming.from_storage_contract_id then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if source_concurrency is null then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency, null::jsonb
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if on_parent_delete = 'empty_optional' then
      effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'effectKind', 'optional_cleared', 'storageContractId', incoming.from_storage_contract_id,
        'recordTypeId', source_catalogue.record_type_id, 'recordId', incoming.from_record_id,
        'preConcurrencyNumber', source_concurrency, 'relationshipId', incoming.relationship_id,
        'previousValue', source_link_value
      ));
      edge_change := vortex_record.prepare_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, false
      );
      edge_changes := edge_changes || pg_catalog.jsonb_build_array(edge_change);
      storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', incoming.from_storage_contract_id, 'recordId', incoming.from_record_id,
        'expectedConcurrencyNumber', source_concurrency,
        'values', pg_catalog.jsonb_build_object(
          source_link_column, null, 'definition_revision', source_meta -> 'moduleReleaseRevision'
        )
      ));
    elsif on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      dependent_plan := vortex_record.prepare_record_delete_closure_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
      storage_changes := storage_changes || (dependent_plan -> 'storageChanges');
      edge_changes := edge_changes || (dependent_plan -> 'edgeChanges');
      effects := effects || (dependent_plan -> 'effects');
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'storageContractId', meta -> 'storageContractId', 'recordId', p_record_id,
    'expectedConcurrencyNumber', p_expected_concurrency_number,
    'values', pg_catalog.jsonb_build_object(
      'lifecycle_state', 'soft_deleted',
      'deleted_at', pg_catalog.statement_timestamp(), 'deleted_by', context_value -> 'organizationAccountId',
      'removal_due_at', null, 'definition_revision', meta -> 'moduleReleaseRevision'
    )
  ));
  effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'effectKind', 'soft_deleted', 'storageContractId', meta -> 'storageContractId',
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'preConcurrencyNumber', p_expected_concurrency_number, 'relationshipId', null, 'previousValue', null
  ));
  -- Each outer root replaces the recursive root tags with its own identity.
  -- The set preparation unions these tags when closures share an effect.
  select coalesce(pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
    'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ))
  ) order by item.ordinality), '[]'::jsonb) into effects
  from pg_catalog.jsonb_array_elements(effects) with ordinality as item(value, ordinality);
  return pg_catalog.jsonb_build_object(
    'storageChanges', storage_changes, 'edgeChanges', edge_changes, 'effects', effects
  );
end
$function$;

alter function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) is
  'Private delete closure preparation: locks and authorizes the root, dependent records and cleared optional links, returning their complete storage, edge and journal changes without writing records.';

create or replace function vortex_record.prepare_record_lifecycle_generated_values_internal(
  p_preparation jsonb,
  p_include_root boolean,
  p_mutations jsonb,
  p_proposed_records jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  expected_mutations jsonb;
  supplied_mutations jsonb;
  mutation_value jsonb;
  prepared_record jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  parent_plan jsonb;
  parent_plans jsonb := '[]'::jsonb;
  storage_changes jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or p_include_root is null then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values are invalid';
  end if;
  perform vortex_access.validated_human_request_context();
  catalogue := vortex_record.relationship_total_catalogue_internal()
    || pg_catalog.jsonb_build_object('proposedRecords', p_proposed_records);

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
        from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') as field(value)
        where field.value ->> 'type' in ('total', 'calculation')
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into expected_mutations
  from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
  where p_include_root or item.value ->> 'recordKey' <> 'root';

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.lower(field_id) order by pg_catalog.lower(field_id) collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_mutations
  from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and item.value - array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
      = '{}'::jsonb
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';

  if supplied_mutations is distinct from expected_mutations
    or pg_catalog.jsonb_array_length(supplied_mutations)
      <> pg_catalog.jsonb_array_length(p_mutations) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values do not match the locked closure';
  end if;

  for mutation_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_record
    from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
    where item.value ->> 'recordTypeId' = mutation_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = mutation_value ->> 'recordId'
      and (p_include_root or item.value ->> 'recordKey' <> 'root');
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(mutation_value -> 'finalValues') as entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_record -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
    );
    parent_plan := vortex_record.prepare_relationship_total_parent_internal(
      (mutation_value ->> 'recordTypeId')::uuid,
      (mutation_value ->> 'recordId')::uuid,
      (mutation_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values, catalogue
    );
    if parent_plan is not null then
      parent_plans := parent_plans || pg_catalog.jsonb_build_array(parent_plan);
      storage_changes := storage_changes || pg_catalog.jsonb_build_array(parent_plan -> 'storageChange');
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('storageChanges', storage_changes, 'parentPlans', parent_plans);
end
$function$;

alter function vortex_record.prepare_record_lifecycle_generated_values_internal(jsonb,boolean,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_lifecycle_generated_values_internal(
  jsonb, boolean, jsonb, jsonb
) is
  'Private lifecycle generated-field preparation: checks the complete locked closure and returns its physical changes and parent effects for one set-based write.';

create or replace function vortex_record.prepare_record_lifecycle_totals_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid,
  p_root_snapshot jsonb,
  p_proposed_records jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  rule_module_root_id uuid;
  rule_release_revision bigint;
  parent_read jsonb;
  lifecycle_effect record;
  lifecycle_loaded jsonb;
  lifecycle_type jsonb;
  lifecycle_proposed jsonb;
  lifecycle_records jsonb := '[]'::jsonb;
begin
  if p_operation is null or p_operation not in ('delete', 'restore')
    or (p_operation = 'restore' and p_root_snapshot is not null)
    or pg_catalog.jsonb_typeof(p_proposed_records) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Record lifecycle total preparation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  catalogue := vortex_record.relationship_total_catalogue_internal()
    || pg_catalog.jsonb_build_object('proposedRecords', p_proposed_records);

  before_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'relationship_refused',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    ) is null then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
  end loop;

  after_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if after_closure is null
    or (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from
      (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;

  for prepared_record in
    select ordered.value
    from (
      select p_root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root') as value,
        0 as position, '' as record_key
      where p_root_snapshot is not null
      union all
      select item.value,
        case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
        item.value ->> 'recordKey'
      from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    ) as ordered
    order by ordered.position, ordered.record_key collate "C"
  loop
    begin
      select storage.module_root_id into strict rule_module_root_id
      from vortex_record.storage_catalogue storage
      where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
        and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
        and storage.state = 'active';
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_STORAGE_LOOKUP_FAILED',
          detail = pg_catalog.format('storage=%s type=%s cause=%s',
            prepared_record ->> 'storageContractId',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    begin
      select (item.value ->> 'moduleReleaseRevision')::bigint
        into strict rule_release_revision
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
      where (item.value ->> 'recordTypeId')::uuid =
        (prepared_record ->> 'recordTypeId')::uuid;
    exception
      when no_data_found or too_many_rows then
        raise exception using errcode = '55000',
          message = 'RELATIONSHIP_TOTAL_RELEASE_LOOKUP_FAILED',
          detail = pg_catalog.format('type=%s cause=%s',
            prepared_record ->> 'recordTypeId', sqlstate);
    end;
    if prepared_record ->> 'recordKey' <> 'root' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid,
        (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    else
      parent_read := null;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', prepared_record ->> 'recordKey' = 'root'
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        rule_module_root_id, rule_release_revision,
        (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      relationship_value := null;
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      source_type := null;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select distinct candidate.* from (
          select edge.* from vortex_record.relationship_edges as edge
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
          union
          select (pg_catalog.jsonb_populate_record(null::vortex_record.relationship_edges,
            pg_catalog.jsonb_build_object(
              'relationship_id', relationship_value -> 'relationshipId',
              'from_organisation_id', context_organization_id, 'to_organisation_id', context_organization_id,
              'from_storage_contract_id', source_type -> 'storageContractId', 'from_record_id', proposed.value -> 'recordId',
              'to_storage_contract_id', prepared_record -> 'storageContractId', 'to_record_id', prepared_record -> 'recordId',
              'from_application_root_id', case when source_type ->> 'storageScope' = 'application_contained'
                then context_application_id else null end,
              'to_application_root_id', case when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
                then context_application_id else null end
            )
          )).* from pg_catalog.jsonb_array_elements(p_proposed_records) as proposed(value)
          where proposed.value -> 'storageContractId' = source_type -> 'storageContractId'
            and proposed.value ->> 'lifecycleState' = 'active'
            and proposed.value -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
              = prepared_record -> 'recordId'
            and proposed.value -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
              = prepared_record -> 'recordTypeId'
        ) as candidate
        order by candidate.from_storage_contract_id, candidate.from_record_id
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
        if source_snapshot -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
            is distinct from prepared_record -> 'recordId'
          or source_snapshot -> 'existingValues' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
            is distinct from prepared_record -> 'recordTypeId' then continue; end if;
        source_key := null;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
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

  -- Every record removed or recovered by the command has its own lifecycle
  -- rules. Keep those stored-value snapshots separate from generated-field
  -- parents, whose applicable operation remains update.
  for lifecycle_effect in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
      and effect.effect_kind = case when p_operation = 'delete' then 'soft_deleted' else 'restored' end
    order by effect.storage_contract_id, effect.record_id
  loop
    select item.value into strict lifecycle_type
    from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = lifecycle_effect.record_type_id;
    lifecycle_loaded := vortex_record.load_record_access_facts_internal(
      lifecycle_effect.record_type_id, p_operation, lifecycle_effect.record_id,
      null, null
    );
    if lifecycle_loaded ->> 'outcome' is distinct from 'loaded' then
      raise exception using errcode = '55000', message = 'Lifecycle rule snapshot is unavailable';
    end if;
    select storage.module_root_id into strict rule_module_root_id
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = lifecycle_effect.storage_contract_id
      and storage.record_type_id = lifecycle_effect.record_type_id
      and storage.state = 'active';
    select item.value into lifecycle_proposed
    from pg_catalog.jsonb_array_elements(p_proposed_records) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = lifecycle_effect.record_type_id
      and (item.value ->> 'recordId')::uuid = lifecycle_effect.record_id;
    lifecycle_records := lifecycle_records || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordKey', case when lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id then 'root'
          else lifecycle_effect.record_type_id::text || ':' || lifecycle_effect.record_id::text end,
        'recordType', lifecycle_type - 'moduleReleaseRevision',
        'recordId', lifecycle_effect.record_id,
        'concurrencyNumber', lifecycle_loaded -> 'concurrencyNumber',
        'existingValues', case when p_root_snapshot is not null
            and lifecycle_effect.record_type_id = p_record_type_id
            and lifecycle_effect.record_id = p_record_id
          then p_root_snapshot -> 'existingValues'
          when p_operation = 'restore' and lifecycle_proposed is not null
            then lifecycle_proposed -> 'existingValues'
          else lifecycle_loaded -> 'fieldValues' end,
        'canRead', lifecycle_effect.record_type_id = p_record_type_id and lifecycle_effect.record_id = p_record_id,
        'relationshipSources', '[]'::jsonb,
        'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
          rule_module_root_id, (lifecycle_type ->> 'moduleReleaseRevision')::bigint,
          lifecycle_effect.record_type_id
        )
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records,
    'lifecycleRecords', lifecycle_records
  );
end
$function$;
alter function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb, jsonb) is null;

create or replace function vortex_record.prepare_record_restore_closure_internal(
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
  context_value jsonb;
  delete_command_id uuid;
  effects jsonb;
  subjects jsonb := '[]'::jsonb;
  subject jsonb;
  effect jsonb;
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  stored_fact jsonb;
  relationship_value jsonb;
  bounds jsonb;
  restored_values jsonb;
  physical_values jsonb;
  missing_links integer;
  current_lifecycle text;
  current_revision bigint;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  -- The current root revision identifies the delete that removed this record.
  -- A different actor may restore it only under their own current permissions.
  select entry.command_id into delete_command_id
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.record_type_id = p_record_type_id
    and entry.record_id = p_record_id
    and entry.effect_kind = 'soft_deleted'
    and entry.post_concurrency_number = p_expected_concurrency_number
    and entry.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ));
  if delete_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(entry) order by entry.effect_sequence),
    pg_catalog.count(*) filter (
      where entry.effect_kind = 'optional_cleared' and entry.previous_value is null
    )::integer
  into effects, missing_links
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.command_id = delete_command_id
    and entry.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ));

  -- Lock the complete affected set before changing any row. A cleared-link
  -- source can occur more than once; its last journaled revision is authoritative.
  for subject in
    select pg_catalog.jsonb_build_object(
      'storageContractId', item.value -> 'storage_contract_id',
      'recordTypeId', item.value -> 'record_type_id',
      'recordId', item.value -> 'record_id',
      'expectedConcurrencyNumber', pg_catalog.max((item.value ->> 'post_concurrency_number')::bigint),
      'deleted', pg_catalog.bool_or(item.value ->> 'effect_kind' = 'soft_deleted'),
      'shared', pg_catalog.bool_or(pg_catalog.jsonb_array_length(item.value -> 'delete_roots') > 1)
    )
    from pg_catalog.jsonb_array_elements(effects) as item(value)
    where item.value ->> 'effect_kind' = 'soft_deleted'
      or item.value -> 'previous_value' <> 'null'::jsonb
    group by item.value -> 'storage_contract_id', item.value -> 'record_type_id',
      item.value -> 'record_id'
    order by item.value -> 'storage_contract_id', item.value -> 'record_id'
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end
    );
    -- A shared closure row restored through another root stays active; it is
    -- not rewritten and its later edits are preserved. The requested root must
    -- itself still be deleted at the displayed revision.
    execute pg_catalog.format(
      'select stored.lifecycle_state, stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2 for update',
      meta ->> 'table'
    ) into current_lifecycle, current_revision
    using (context_value ->> 'organizationId')::uuid, (subject ->> 'recordId')::uuid;
    if (subject ->> 'deleted')::boolean and (subject ->> 'shared')::boolean
      and current_lifecycle = 'active'
      and ((subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid)
        is distinct from (p_record_type_id, p_record_id) then
      continue;
    end if;
    loaded := vortex_record.load_record_access_facts_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end,
      (subject ->> 'recordId')::uuid,
      (subject ->> 'expectedConcurrencyNumber')::bigint, null
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or meta -> 'storageContractId' is distinct from subject -> 'storageContractId' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into strict stored_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where item.value #>> '{recordScope,recordId}' = subject ->> 'recordId';
    if stored_fact ->> 'lifecycleState' is distinct from
      (case when (subject ->> 'deleted')::boolean then 'soft_deleted' else 'active' end) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- Inherited ownership and permission conditions see the same complete
    -- restored closure, not a partially restored parent or child.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta #> '{declaration,recordBinding}',
      'records', (
        select pg_catalog.jsonb_agg(case when exists (
          select 1 from pg_catalog.jsonb_array_elements(effects) as deleted(value)
          where deleted.value ->> 'effect_kind' = 'soft_deleted'
            and deleted.value ->> 'record_id' = item.value #>> '{recordScope,recordId}'
            and deleted.value ->> 'storage_contract_id' = item.value #>> '{recordScope,storageContractId}'
        ) then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end order by item.ordinality)
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := vortex_access.evaluate_organization_record_access_internal(
      meta -> 'declaration', (subject ->> 'recordId')::uuid, facts
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    restored_values := loaded -> 'fieldValues';
    physical_values := '{}'::jsonb;
    for effect in
      select item.value from pg_catalog.jsonb_array_elements(effects) as item(value)
      where item.value ->> 'effect_kind' = 'optional_cleared'
        and item.value ->> 'storage_contract_id' = subject ->> 'storageContractId'
        and item.value ->> 'record_id' = subject ->> 'recordId'
        and item.value -> 'previous_value' <> 'null'::jsonb
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
      where item.value ->> 'relationshipId' = effect ->> 'relationship_id';
      if relationship_value is null
        or not (bounds -> 'changeableFieldIds') ? (relationship_value ->> 'fromFieldId')
        or coalesce(loaded -> 'fieldValues' -> (relationship_value ->> 'fromFieldId'), 'null'::jsonb)
          <> 'null'::jsonb then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      restored_values := restored_values || pg_catalog.jsonb_build_object(
        relationship_value ->> 'fromFieldId', effect -> 'previous_value'
      );
      physical_values := physical_values || pg_catalog.jsonb_build_object(
        meta -> 'columns' -> (relationship_value ->> 'fromFieldId') ->> 'token',
        effect -> 'previous_value'
      );
    end loop;
    subjects := subjects || pg_catalog.jsonb_build_array(subject || pg_catalog.jsonb_build_object(
      'table', meta -> 'table', 'releaseRevision', meta -> 'moduleReleaseRevision',
      'recordType', meta -> 'recordType', 'columns', meta -> 'columns',
      'values', restored_values,
      'storageChange', pg_catalog.jsonb_build_object(
        'storageContractId', subject -> 'storageContractId', 'recordId', subject -> 'recordId',
        'expectedConcurrencyNumber', subject -> 'expectedConcurrencyNumber',
        'values', physical_values || pg_catalog.jsonb_build_object(
          'definition_revision', meta -> 'moduleReleaseRevision'
        ) || case when (subject ->> 'deleted')::boolean then pg_catalog.jsonb_build_object(
          'lifecycle_state', 'active', 'deleted_at', null, 'deleted_by', null, 'removal_due_at', null
        ) else '{}'::jsonb end
      )
    ));
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'subjects', subjects,
    'storageChanges', (select pg_catalog.jsonb_agg(item.value -> 'storageChange')
      from pg_catalog.jsonb_array_elements(subjects) as item(value)),
    'unrestoredLinkCount', missing_links
  );
end
$function$;

alter function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) is
  'Private restore closure preparation: locates the deleting command and locks its unchanged retained records and recoverable optional links under current authority, without writing records.';

create or replace function vortex_record.prepare_record_restore_internal(
  p_command_id uuid,
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
  context_value jsonb;
  receipt_claim jsonb;
  plan_value jsonb;
  storage_set jsonb;
  preparation jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_restore', p_command_id, false
  );
  if receipt_claim ->> 'status' = 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'restored', 'recordId', receipt_claim -> 'result' -> 'recordId',
      'concurrencyNumber', receipt_claim -> 'result' -> 'concurrencyNumber',
      'correlationId', context_value -> 'correlationId', 'replayed', true,
      'unrestoredLinkCount', receipt_claim #> '{result,unrestoredLinkCount}'
    );
  elsif receipt_claim ->> 'status' is distinct from 'claimed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  plan_value := vortex_record.prepare_record_restore_closure_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if plan_value ->> 'outcome' is distinct from 'prepared' then return plan_value; end if;
  storage_set := vortex_record.prepare_record_storage_set_internal(plan_value -> 'storageChanges');
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', p_command_id::text, true);
  perform vortex_record.append_record_lifecycle_effect_internal((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'effectKind', case when (item.value ->> 'deleted')::boolean then 'restored' else 'links_restored' end,
      'storageContractId', item.value -> 'storageContractId',
      'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
      'preConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'relationshipId', null, 'previousValue', null,
      'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id, 'recordId', p_record_id
      ))
    )) from pg_catalog.jsonb_array_elements(plan_value -> 'subjects') as item(value)
  ));
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null, storage_set -> 'proposedRecords'
  );
  return preparation || pg_catalog.jsonb_build_object('unrestoredLinkCount', plan_value -> 'unrestoredLinkCount');
end
$function$;

alter function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_internal(uuid,uuid,uuid,bigint) is
  'Private restore preparation: claims one command, journals its locked closure and prepares lifecycle rules and generated values against the proposed graph before any record write.';

create or replace function vortex_record.prepare_record_storage_set_internal(p_changes jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  change_value jsonb;
  record_type_id_value uuid;
  loaded jsonb;
  record_fact jsonb;
  proposed_values jsonb;
  proposed_records jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(distinct item.value -> 'expectedConcurrencyNumber') > 1
  ) then
    raise exception using errcode = '40001', message = 'Prepared record revisions disagree';
  end if;

  -- Different closure members may change separate fields on the same record.
  -- Compose those changes before reading its proposed logical snapshot.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'storageContractId', subject.storage_id, 'recordId', subject.record_id,
    'expectedConcurrencyNumber', subject.revision,
    'values', (
      select pg_catalog.jsonb_object_agg(field.key, field.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(p_changes) with ordinality as item(value, ordinality)
      cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
      where item.value -> 'storageContractId' = subject.storage_id
        and item.value -> 'recordId' = subject.record_id
    )
  ) order by subject.storage_id, subject.record_id), '[]'::jsonb) into storage_changes
  from (
    select item.value -> 'storageContractId' as storage_id,
      item.value -> 'recordId' as record_id,
      pg_catalog.max((item.value ->> 'expectedConcurrencyNumber')::bigint) as revision
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
  ) as subject;

  for change_value in select item.value from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
  loop
    select storage.record_type_id into strict record_type_id_value
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (change_value ->> 'storageContractId')::uuid;
    loaded := vortex_record.load_record_access_facts_internal(
      record_type_id_value, 'update', (change_value ->> 'recordId')::uuid,
      (change_value ->> 'expectedConcurrencyNumber')::bigint, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or loaded #> '{recordTypeMeta,storageContractId}' is distinct from change_value -> 'storageContractId' then
      raise exception using errcode = '40001', message = 'Prepared record storage closure changed';
    end if;
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') as item(value)
    where item.value #>> '{recordScope,recordId}' = change_value ->> 'recordId';
    select (loaded -> 'fieldValues') || coalesce(pg_catalog.jsonb_object_agg(
      field.key, change_value -> 'values' -> (field.value ->> 'token')
    ), '{}'::jsonb) into proposed_values
    from pg_catalog.jsonb_each(loaded -> 'columns') as field(key, value)
    where (change_value -> 'values') ? (field.value ->> 'token');
    proposed_records := proposed_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', record_type_id_value, 'storageContractId', change_value -> 'storageContractId',
      'recordId', change_value -> 'recordId', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'existingValues', proposed_values,
      'lifecycleState', coalesce(change_value #>> '{values,lifecycle_state}', record_fact ->> 'lifecycleState')
    ));
  end loop;
  return pg_catalog.jsonb_build_object('storageChanges', storage_changes, 'proposedRecords', proposed_records);
end
$function$;

alter function vortex_record.prepare_record_storage_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_storage_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_storage_set_internal(jsonb) is
  'Private preparation of an already-authorized lifecycle closure: composes repeated record changes and supplies proposed logical snapshots for generated-field calculation before any physical write.';

create or replace function vortex_record.prepare_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_catalogue jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  physical_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return null; end if;
  catalogue := p_catalogue;
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    physical_values := physical_values || pg_catalog.jsonb_build_object(column_value ->> 'token', entry.value);
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  return pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids), 'snapshot', snapshot,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', snapshot -> 'storageContractId', 'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object('definition_revision', snapshot -> 'definitionRevision')
    )
  );
end
$function$;

alter function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) is
  'Prepares protected generated totals and calculations against a locked current or proposed snapshot for the shared record storage writer.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.prepare_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_bump_data_version boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
  existing_other boolean;

begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_bump_data_version is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  if source_meta ? 'previewInstallationId' then
    -- The exact owner-validated preview definition is its mapping. A live mapping's single
    -- relationship identity must never be repointed at a preview's isolated storage.
    mapping_row.source_storage_contract_id := (source_meta ->> 'storageContractId')::uuid;
    mapping_row.cardinality := relationship_value ->> 'cardinality';
    mapping_row.on_parent_delete := relationship_value ->> 'onParentDelete';
    select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid)
    into mapping_row.target_record_type_ids
    from pg_catalog.jsonb_array_elements(case when relationship_value ? 'toRecordType'
      then pg_catalog.jsonb_build_array(relationship_value -> 'toRecordType')
      else relationship_value -> 'toRecordTypes' end) as target(value);
  else
    select mapping.* into mapping_row
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.relationship_id = p_relationship_id
      and mapping.source_storage_contract_id =
        (source_meta ->> 'storageContractId')::uuid
      and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
      and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
    if not found
      or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
      or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
      raise exception using errcode = '55000',
        message = 'Relationship storage disagrees with the active definition';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_bump_data_version then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    return pg_catalog.jsonb_build_object(
      'relationshipId', p_relationship_id,
      'sourceRecordId', p_source_record_id,
      'sourceStorageContractId', source_meta -> 'storageContractId',
      'sourceApplicationRootId', case when source_meta ->> 'storageScope' = 'application_contained'
        then source_context -> 'applicationRootId' else null end,
      'table', source_meta -> 'table', 'column', field_column -> 'token',
      'value', p_target_value, 'cardinality', mapping_row.cardinality
    );
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  target_loaded := vortex_record.load_record_access_facts_internal(
    target_type_id, 'read', target_record_id, null, null::jsonb
  );
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if source_meta ? 'previewInstallationId'
    and target_loaded ->> 'previewInstallationId' = source_meta ->> 'previewInstallationId'
    and exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
        and root.owner_application_root_id = (source_context ->> 'applicationRootId')::uuid
    ) then
    target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
  else
    if pg_catalog.jsonb_array_length(
      target_loaded #> '{declaration,requiredPermissions}'
    ) = 0 then
      raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
    end if;
    target_decision := vortex_access.evaluate_organization_record_access_internal(
      pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}',
        '{"kind":"permission"}'::jsonb), target_record_id, target_loaded -> 'facts'
    );
  end if;
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_bump_data_version then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  if mapping_row.cardinality = 'one_to_one' then
    select exists (
      select 1 from vortex_record.relationship_edges as edge
      where edge.relationship_id = p_relationship_id
        and edge.to_organisation_id = (source_context ->> 'organizationId')::uuid
        and edge.to_storage_contract_id = (target_meta ->> 'storageContractId')::uuid
        and edge.to_record_id = target_record_id
        and edge.from_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
        and edge.from_record_id <> p_source_record_id
    ) into existing_other;
    if existing_other then
      raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
    end if;
  end if;

  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    -- A record type's one-record link to itself is a parent link: it must never make a cycle.
    perform vortex_record.assert_relationship_acyclic_internal(
      p_relationship_id, (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid, (field_value ->> 'fieldId')::uuid,
      p_source_record_id, target_record_id
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'relationshipId', p_relationship_id,
    'sourceRecordId', p_source_record_id,
    'sourceStorageContractId', source_meta -> 'storageContractId',
    'sourceApplicationRootId', source_application_root_id,
    'targetStorageContractId', target_meta -> 'storageContractId',
    'targetRecordId', target_record_id,
    'targetApplicationRootId', target_application_root_id,
    'table', source_meta -> 'table', 'column', field_column -> 'token',
    'value', p_target_value, 'cardinality', mapping_row.cardinality
  );
end
$function$;

alter function vortex_record.prepare_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship preparation: validates the declared relationship and target eligibility, locks target and edge identities, checks cardinality and cycles, and returns the typed field and edge mutation for the record writer.';

create or replace function vortex_record.record_lifecycle_total_closure_internal(
  p_catalogue jsonb,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  context_actor_id uuid;
  seed record;
  seed_key text;
  closure_value jsonb;
  closure_record jsonb;
  record_key text;
  records jsonb := '[]'::jsonb;
  record_keys text[] := array[]::text[];
  signatures jsonb := '[]'::jsonb;
begin
  if p_operation is null or p_operation not in ('delete', 'restore') or p_command_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_catalogue -> 'relationships') is distinct from 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;

  for seed in
    select distinct effect.record_type_id, effect.storage_contract_id, effect.record_id
    from vortex_record.record_lifecycle_command_effects as effect
    where ((p_operation = 'restore' and effect.effect_kind in ('restored', 'links_restored'))
        or (p_operation = 'delete' and effect.effect_kind = 'optional_cleared'))
      and effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = context_actor_id
      and effect.command_id = p_command_id
      and not (p_operation = 'delete' and exists (
        select 1 from vortex_record.record_lifecycle_command_effects as deleted
        where deleted.organization_id = effect.organization_id
          and deleted.command_id = effect.command_id
          and deleted.storage_contract_id = effect.storage_contract_id
          and deleted.record_id = effect.record_id and deleted.effect_kind = 'soft_deleted'
      ))
    union
    select distinct
      (target_type.value ->> 'recordTypeId')::uuid as record_type_id,
      edge.to_storage_contract_id as storage_contract_id,
      edge.to_record_id as record_id
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.relationship_edges as edge
      on edge.from_organisation_id = effect.organization_id
     and edge.from_storage_contract_id = effect.storage_contract_id
     and edge.from_record_id = effect.record_id
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(edge.relationship_id::text)
        and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
    ) as relationship
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where (item.value ->> 'storageContractId')::uuid = edge.to_storage_contract_id
        and vortex_record.relationship_declares_target_internal(
          relationship.value, (item.value ->> 'recordTypeId')::uuid
        )
    ) as target_type
    where p_operation = 'delete'
      and effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = context_actor_id
      and effect.command_id = p_command_id
      and effect.effect_kind = 'soft_deleted'
      and edge.to_organisation_id = context_organization_id
      and edge.to_application_root_id is not distinct from case
        when target_type.value ->> 'storageScope' = 'application_contained'
          then context_application_id else null end
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_type.value -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
            pg_catalog.lower(relationship.value ->> 'relationshipId')
      )
      and not exists (
        select 1 from vortex_record.record_lifecycle_command_effects as deleted
        where deleted.organization_id = effect.organization_id
          and deleted.application_root_id = effect.application_root_id
          and deleted.actor_organization_account_id = effect.actor_organization_account_id
          and deleted.command_id = effect.command_id
          and deleted.effect_kind = 'soft_deleted'
          and deleted.storage_contract_id = edge.to_storage_contract_id
          and deleted.record_id = edge.to_record_id
      )
    order by 2, 3
  loop
    seed_key := case when p_operation = 'restore'
        and seed.record_type_id = p_record_type_id and seed.record_id = p_record_id
      then 'root' else pg_catalog.lower(seed.record_type_id::text) || ':'
        || pg_catalog.lower(seed.record_id::text) end;
    -- A parent already reached is complete: discovery follows every
    -- transitive total parent of each member it adds.
    if seed_key = any (record_keys) then
      continue;
    end if;
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', seed.record_type_id, seed.record_id, '{}'::jsonb
    );
    if closure_value is null then
      return null;
    end if;
    for closure_record in
      select item.value
      from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
    loop
      record_key := case when p_operation = 'restore'
          and (closure_record ->> 'recordTypeId')::uuid = p_record_type_id
          and (closure_record ->> 'recordId')::uuid = p_record_id then 'root'
        when closure_record ->> 'recordKey' = 'root'
          then seed_key else closure_record ->> 'recordKey' end;
      if record_key = any (record_keys) then
        continue;
      end if;
      records := records || pg_catalog.jsonb_build_array(
        closure_record || pg_catalog.jsonb_build_object('recordKey', record_key)
      );
      record_keys := pg_catalog.array_append(record_keys, record_key);
    end loop;
    signatures := signatures || coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'from', case when item.value ->> 'from' = 'root'
          then seed_key else item.value ->> 'from' end,
        'relationshipId', item.value -> 'relationshipId',
        'to', case when item.value ->> 'to' = 'root'
          then seed_key else item.value ->> 'to' end
      ))
      from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    ), '[]'::jsonb);
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid) is null;

create or replace function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
  proposed_record jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  -- The record writer may supply its already-locked proposed closure while
  -- preparing generated fields. This lets a delete or restore calculate its
  -- final totals before its one physical write, using the same snapshot path.
  select item.value into proposed_record
  from pg_catalog.jsonb_array_elements(coalesce(p_catalogue -> 'proposedRecords', '[]'::jsonb)) as item(value)
  where item.value ->> 'recordTypeId' = p_record_type_id::text
    and item.value ->> 'recordId' = p_record_id::text;
  if proposed_record is not null then
    if proposed_record ->> 'lifecycleState' <> 'active' then return null; end if;
    return (proposed_record - 'lifecycleState') || pg_catalog.jsonb_build_object(
      'recordType', record_type - 'moduleReleaseRevision',
      'definitionRevision', record_type -> 'moduleReleaseRevision'
    );
  end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s', ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              ordered_fields.value ->> 'token'
            )
            when 'date' then pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              ordered_fields.value ->> 'token'
            )
            else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', ordered_fields.value ->> 'token')
          end
        ), ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select entry.key, entry.value,
        pg_catalog.row_number() over (
          order by entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

alter function vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
) is
  'Private locked-or-read snapshot of one record for the validated human Application request context.';

CREATE OR REPLACE FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  lifecycle_state_value text;
begin
  if p_record_type_id is null or p_record_id is null or p_organization_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array' then
    return false;
  end if;
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then
    return false;
  end if;
  select item.value ->> 'lifecycleState' into lifecycle_state_value
  from pg_catalog.jsonb_array_elements(coalesce(p_catalogue -> 'proposedRecords', '[]'::jsonb)) as item(value)
  where item.value ->> 'recordTypeId' = p_record_type_id::text
    and item.value ->> 'recordId' = p_record_id::text;
  if found then return lifecycle_state_value <> 'active'; end if;
  select stored.* into catalogue_row
  from vortex_record.storage_catalogue as stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then
    return false;
  end if;
  execute pg_catalog.format(
    'select stored.lifecycle_state from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $3',
    catalogue_row.physical_table_token
  ) into lifecycle_state_value using
    p_organization_id, p_record_id,
    case when record_type ->> 'storageScope' = 'application_contained'
      then p_application_root_id else null end;
  return lifecycle_state_value is not null and lifecycle_state_value <> 'active';
end
$_$;
alter function vortex_record.relationship_total_source_is_retained_internal(jsonb,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;

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
  actor_id_value uuid; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
  updated_record_id uuid; updated_organization_id uuid; updated_application_root_id uuid;
  storage_scope_value text; preview_installation jsonb;
  exact_notice boolean := false; notice_sequence bigint;
  correlation_id_value uuid;
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
  context_value := vortex_access.lock_human_request_access_version_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  if correlation_id_value is null or not vortex_platform.is_non_nil_uuid(correlation_id_value::text) then
    raise exception using errcode='42501',message='Offboarding ownership transfer authority is unavailable';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim -> 'result' ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim -> 'result' ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
    or loaded ->> 'installationState' is null
    or loaded ->> 'installationState' not in ('active', 'detached')
    or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,records}') is distinct from 'array'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,recordTypes}') is distinct from 'array' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  storage_scope_value := record_fact #>> '{recordScope,storageScope}';
  if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
    or pg_catalog.jsonb_typeof(type_fact) is distinct from 'object'
    or record_fact ->> 'lifecycleState' is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' is distinct from 'soft_deleted')
    or type_fact ->> 'ownershipMode' is distinct from 'organization_account'
    or storage_scope_value is null
    or storage_scope_value not in ('application_contained', 'organization_shared')
    or (record_fact #>> '{recordScope,organizationId}')::uuid is distinct from organization_id_value
    or (record_fact #>> '{recordScope,recordTypeId}')::uuid is distinct from p_record_type_id
    or (record_fact #>> '{recordScope,storageContractId}')::uuid is distinct from (type_fact ->> 'storageContractId')::uuid
    or type_fact ->> 'storageContractId' is null
    or not vortex_platform.is_non_nil_uuid(type_fact ->> 'storageContractId')
    or (storage_scope_value = 'application_contained'
      and (record_fact #>> '{recordScope,applicationRootId}')::uuid is distinct from application_root_id_value)
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
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.record_id,stored.concurrency_number,stored.organisation_id,%s',
    loaded ->> 'table',
    case when storage_scope_value = 'application_contained'
      then 'stored.application_root_id' else 'null::uuid' end
  ) into updated_record_id,updated_concurrency,updated_organization_id,updated_application_root_id
    using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  if updated_record_id is distinct from p_record_id
    or not vortex_platform.is_non_nil_uuid(updated_record_id::text)
    or updated_organization_id is distinct from organization_id_value
    or updated_concurrency is null
    or updated_concurrency not between 1 and 9007199254740991
    or (storage_scope_value = 'application_contained'
      and updated_application_root_id is distinct from application_root_id_value) then
    raise exception using errcode='40001',message='Offboarding ownership transfer revision changed';
  end if;
  perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode='42501',message='Preview Record context is unavailable';
  end if;
  exact_notice := preview_installation is null
    and loaded ->> 'installationState' = 'active'
    and storage_scope_value = 'application_contained';
  if exact_notice then
    -- Defer the exact notice until the protected transfer is complete.
    null;
  else
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, (type_fact ->> 'storageContractId')::uuid,
      case when storage_scope_value = 'application_contained'
        then application_root_id_value else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_platform.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_platform.append_record_occurrences(
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
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
    raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed';
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id,
    pg_catalog.jsonb_build_object('recordId', updated_record_id, 'concurrencyNumber', updated_concurrency),
    'Offboarding ownership transfer receipt is stale'
  );
  if exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode='22023',message='Invalidation notice command is invalid';
      end if;
      perform vortex_platform.publish_change_notice(
        updated_organization_id, updated_application_root_id, p_record_type_id,
        updated_record_id, updated_concurrency, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Notice allocation and publication are advisory after the protected transfer is complete.
      null;
    end;
  end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',updated_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

alter function vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

create or replace function vortex_record.validate_record_restore_set_internal(p_subjects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subjects jsonb := p_subjects;
  subject jsonb;
  field_value jsonb;
  retained_value jsonb;
  relationship_value jsonb;
  edge_changes jsonb := '[]'::jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  -- Validate retained fields and prepare links against the complete proposed
  -- closure. Any refusal rolls this preparation back, including its row writes.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
    loop
      if not (subject ->> 'deleted')::boolean
        and not (subject #> '{storageChange,values}') ? (
          subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'token'
        ) then continue; end if;
      retained_value := coalesce(subject -> 'values' -> (field_value ->> 'fieldId'), 'null'::jsonb);
      if (field_value ->> 'required')::boolean and retained_value = 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Required retained value is unavailable';
      end if;
      if retained_value = 'null'::jsonb then continue; end if;
      if not vortex_record.canonical_record_value_matches(
        retained_value, field_value ->> 'type',
        subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514', message = 'Retained value is invalid';
      end if;
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into strict relationship_value
        from pg_catalog.jsonb_array_elements(subject #> '{recordType,relationships}') as item(value)
        where item.value ->> 'fromFieldId' = field_value ->> 'fieldId';
        begin
          edge_changes := edge_changes || pg_catalog.jsonb_build_array(
            vortex_record.prepare_relationship_value_internal(
              (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
              (relationship_value ->> 'relationshipId')::uuid, retained_value, false
            )
          );
        exception when no_data_found then
          raise exception using errcode = '23514', message = 'Retained relationship is unavailable';
        end;
      end if;
    end loop;
  end loop;
  perform vortex_record.apply_relationship_edges_internal(edge_changes);

  -- Re-evaluate the actual proposed records, including recovered optional
  -- links, before exposing preparation to the runtime rule evaluator.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    loaded := vortex_record.load_record_access_facts_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end,
      (subject ->> 'recordId')::uuid, null, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', (subject ->> 'recordId')::uuid, loaded -> 'facts'
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
      where (subject #> '{storageChange,values}') ? (subject -> 'columns' -> (item.value ->> 'fieldId') ->> 'token')
    loop
      if not (bounds -> 'changeableFieldIds') ? (field_value ->> 'fieldId') then
        raise exception using errcode = '42501', message = 'Restored relationship is unavailable';
      end if;
    end loop;
  end loop;
end
$function$;

alter function vortex_record.validate_record_restore_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_record_restore_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.validate_record_restore_set_internal(jsonb) is
  'Private restore finalization: validates retained values and recovered targets, applies the prepared edge set once and checks current authority against the complete restored graph.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared jsonb;
  context_value jsonb;
  changed_rows integer;
begin
  prepared := vortex_record.prepare_relationship_value_internal(
    p_source_record_type_id, p_source_record_id, p_relationship_id,
    p_target_value, p_increment_source_revision
  );
  context_value := vortex_access.validated_human_request_context();
  perform vortex_record.apply_relationship_edges_internal(pg_catalog.jsonb_build_array(prepared));
  execute pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    prepared ->> 'table', prepared ->> 'column',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  ) using (context_value ->> 'organizationId')::uuid, p_source_record_id, p_target_value,
    (context_value ->> 'organizationAccountId')::uuid;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, checks current application access for flagged Person links, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';
drop function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid);

create or replace function vortex_record.prepare_named_action_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
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
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  physical_values jsonb := '{}'::jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_entry ->> 'token', entry_value
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, proposed_facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'values', values_value,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', loaded #> '{actionContext,storageContractId}',
      'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object(
        'definition_revision', loaded -> 'moduleReleaseRevision'
      )
    )
  );
end
$function$;

alter function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) to vortex_record_adapter;
comment on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) is
  'Private named-action update preparation: checks current and proposed action authority and field bounds, and returns the typed storage mutation without writing the record.';

set role vortex_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
