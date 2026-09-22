-- #559: complete deadline due coverage.
--
-- `vortex_record.record_deadline_due_metadata` holds each record's next pending
-- deadline transition. #556 kept it current for the root of an ordinary save;
-- the #557 claim and #558 closure remain the single refresh authority that
-- recalculates a due record and replaces or cancels its row. This migration
-- routes every other change to a deadline input through that same table in
-- the changing transaction:
--
-- * Named actions: the target record, every record the action creates and
--   every relationship-total parent it changes.
-- * Relationship-total parents of an ordinary save.
-- * Installation lifecycle: when an Application's Module binding becomes
--   active, every active record in its storage contracts that declares a
--   deadline calculation is reselected; when a binding stops being active its
--   application-contained due rows are removed.
-- * Organisation time zone: every pending row of the organisation is reselected.
--
-- Parent and created-record rows are written at the revision the shared writer
-- actually left. An unchanged parent keeps its existing, still-correct row, so
-- the Record runtime never predicts which parent values change.
--
-- Reselection is not a second evaluator. It makes the affected rows due at the
-- changing statement's timestamp (never later than an existing transition), so
-- the #557/#558 authority recalculates each record under the current
-- definition and time zone and writes its exact next transition. Rows keep the
-- record's own organisation and scope: an organisation-shared record keeps a
-- null Application, and its existing `application_context_required` refusal
-- stays visible rather than being attributed to the activating Application.
--
-- Definition publication needs no separate path: a compatible storage upgrade
-- may only add nullable fields and never changes an existing field's settings,
-- so an organisation's deadline inputs change only when an installation
-- activation binds the new release, which the binding trigger covers.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
-- The postgres-owned binding trigger reads storage contracts across scopes.
grant select on vortex_record.storage_catalogue to postgres;
reset role;

set local role vortex_record_adapter;
-- The postgres-owned triggers maintain rows outside any request scope.
grant select, insert, update, delete on vortex_record.record_deadline_due_metadata to postgres;

-- The current active revision of a record the caller's transaction wrote, in
-- the caller's validated organisation/Application scope, shaped for
-- `write_deadline_closure_due_metadata_internal`.
create function vortex_record.deadline_due_record_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  revision_value bigint;
begin
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.state = 'active'
    and catalogue.physical_schema_token = 'record_data';
  if not found then
    raise exception using errcode = 'P0002', message = 'Deadline due record is unavailable';
  end if;
  execute pg_catalog.format(
    'select stored.concurrency_number
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $3
       and stored.lifecycle_state = ''active''',
    storage_row.physical_table_token
  ) into revision_value using p_organization_id, p_record_id,
    case storage_row.storage_scope
      when 'application_contained' then p_application_root_id
      else null::uuid
    end;
  if revision_value is null then
    raise exception using errcode = 'P0002', message = 'Deadline due record is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'storageContractId', storage_row.storage_contract_id,
    'recordTypeId', storage_row.record_type_id,
    'recordId', p_record_id,
    'recordType', storage_row.record_type_definition,
    'concurrencyNumber', revision_value
  );
end
$function$;

-- Exactly one well-formed due transition for every submitted parent mutation,
-- keyed by the same record and expected revision.
create function vortex_record.parent_deadline_due_transitions_are_valid_internal(
  p_parent_mutations jsonb,
  p_parent_due_transitions jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_parent_due_transitions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_parent_mutations) <>
      pg_catalog.jsonb_array_length(p_parent_due_transitions)
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
    )
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_parent_due_transitions) item(value)
      where case when pg_catalog.jsonb_typeof(item.value) <> 'object' then true
        else not item.value ?& array[
            'storageContractId', 'recordTypeId', 'recordId',
            'expectedConcurrencyNumber', 'dueTransition'
          ]
          or item.value - array[
            'storageContractId', 'recordTypeId', 'recordId',
            'expectedConcurrencyNumber', 'dueTransition'
          ] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(item.value ->> 'storageContractId', 'uuid')
          or not pg_catalog.pg_input_is_valid(item.value ->> 'recordTypeId', 'uuid')
          or not pg_catalog.pg_input_is_valid(item.value ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') <> 'number'
          or not pg_catalog.pg_input_is_valid(
            item.value ->> 'expectedConcurrencyNumber', 'bigint'
          )
          or not vortex_record.deadline_due_transition_is_valid_internal(
            item.value -> 'dueTransition'
          )
        end
    ) then
    return false;
  end if;
  return (
    select pg_catalog.jsonb_agg(supplied.entry order by supplied.entry::text)
    from (
      select pg_catalog.jsonb_build_array(
        pg_catalog.lower(item.value ->> 'recordTypeId'),
        pg_catalog.lower(item.value ->> 'recordId'),
        item.value -> 'expectedConcurrencyNumber'
      ) as entry
      from pg_catalog.jsonb_array_elements(p_parent_due_transitions) item(value)
    ) supplied
  ) is not distinct from (
    select pg_catalog.jsonb_agg(submitted.entry order by submitted.entry::text)
    from (
      select pg_catalog.jsonb_build_array(
        pg_catalog.lower(item.value ->> 'recordTypeId'),
        pg_catalog.lower(item.value ->> 'recordId'),
        item.value -> 'expectedConcurrencyNumber'
      ) as entry
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    ) submitted
  );
end
$function$;

-- Writes the due row of every submitted parent whose revision the shared
-- parent writer advanced. A parent left at its expected revision had no value
-- change, so its existing row still describes it.
create function vortex_record.write_parent_deadline_due_metadata_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_parent_due_transitions jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  parent_entry jsonb;
  parent_record jsonb;
  expected_revision bigint;
  parent_revision bigint;
begin
  for parent_entry in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_due_transitions) item(value)
    order by (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    parent_record := vortex_record.deadline_due_record_internal(
      p_organization_id, p_application_root_id,
      (parent_entry ->> 'storageContractId')::uuid,
      (parent_entry ->> 'recordTypeId')::uuid,
      (parent_entry ->> 'recordId')::uuid
    );
    expected_revision := (parent_entry ->> 'expectedConcurrencyNumber')::bigint;
    parent_revision := (parent_record ->> 'concurrencyNumber')::bigint;
    continue when parent_revision = expected_revision;
    if parent_revision <> expected_revision + 1 then
      raise exception using errcode = '40001',
        message = 'Relationship total parent revision changed';
    end if;
    perform vortex_record.write_deadline_closure_due_metadata_internal(
      p_organization_id, p_application_root_id, parent_record,
      parent_revision, parent_entry -> 'dueTransition'
    );
  end loop;
end
$function$;

-- Exactly one well-formed due transition for every submitted creation ordinal.
create function vortex_record.creation_deadline_due_transitions_are_valid_internal(
  p_creations jsonb,
  p_creation_due_transitions jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(p_creations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_creation_due_transitions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_creations) <>
      pg_catalog.jsonb_array_length(p_creation_due_transitions)
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_creations) item(value)
      where pg_catalog.jsonb_typeof(item.value) <> 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'ordinal') <> 'number'
    )
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_creation_due_transitions) item(value)
      where case when pg_catalog.jsonb_typeof(item.value) <> 'object' then true
        else not item.value ?& array['ordinal', 'dueTransition']
          or item.value - array['ordinal', 'dueTransition'] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(item.value -> 'ordinal') <> 'number'
          or not vortex_record.deadline_due_transition_is_valid_internal(
            item.value -> 'dueTransition'
          )
        end
    ) then
    return false;
  end if;
  return (
    select pg_catalog.jsonb_agg(
      item.value -> 'ordinal' order by (item.value ->> 'ordinal')::numeric
    )
    from pg_catalog.jsonb_array_elements(p_creation_due_transitions) item(value)
  ) is not distinct from (
    select pg_catalog.jsonb_agg(
      item.value -> 'ordinal' order by (item.value ->> 'ordinal')::numeric
    )
    from pg_catalog.jsonb_array_elements(p_creations) item(value)
  );
end
$function$;

-- Writes the due row of every record a named action created with a pending
-- deadline. `p_created_records` is the writer's ordinal-keyed insert result.
create function vortex_record.write_created_deadline_due_metadata_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_creations jsonb,
  p_created_records jsonb,
  p_creation_due_transitions jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  due_entry jsonb;
  creation jsonb;
  created jsonb;
  created_record jsonb;
begin
  for due_entry in
    select item.value from pg_catalog.jsonb_array_elements(p_creation_due_transitions) item(value)
    where pg_catalog.jsonb_typeof(item.value -> 'dueTransition') = 'object'
    order by (item.value ->> 'ordinal')::numeric
  loop
    select item.value into strict creation
    from pg_catalog.jsonb_array_elements(p_creations) item(value)
    where item.value -> 'ordinal' = due_entry -> 'ordinal';
    created := p_created_records -> (creation ->> 'ordinal');
    if pg_catalog.jsonb_typeof(created) is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Named action created record is unavailable';
    end if;
    created_record := vortex_record.deadline_due_record_internal(
      p_organization_id, p_application_root_id,
      (created ->> 'storageContractId')::uuid,
      (creation ->> 'recordTypeId')::uuid,
      (created ->> 'recordId')::uuid
    );
    perform vortex_record.write_deadline_closure_due_metadata_internal(
      p_organization_id, p_application_root_id, created_record,
      (created_record ->> 'concurrencyNumber')::bigint, due_entry -> 'dueTransition'
    );
  end loop;
end
$function$;

drop function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb
);

-- The `20260923030000` root composition and due-metadata upsert/cancellation,
-- unchanged, followed by the due rows of the parents this save changed.
create function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
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
  p_parent_mutations jsonb,
  p_due_transition jsonb,
  p_parent_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  context_value jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  transition_field_id uuid;
  transition_at_value timestamptz;
  metadata_application_root_id uuid;
  saved_record_id uuid;
  saved_concurrency_number bigint;
begin
  if not vortex_record.parent_deadline_due_transitions_are_valid_internal(
    p_parent_mutations, p_parent_due_transitions
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  if p_due_transition is not null then
    if pg_catalog.jsonb_typeof(p_due_transition) <> 'object'
      or p_due_transition - array['calculationFieldId', 'transitionAt'] <> '{}'::jsonb
      or not (p_due_transition ?& array['calculationFieldId', 'transitionAt'])
      or pg_catalog.jsonb_typeof(p_due_transition -> 'calculationFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(p_due_transition -> 'transitionAt') <> 'string'
      or not pg_catalog.pg_input_is_valid(
        p_due_transition ->> 'calculationFieldId', 'uuid'
      )
      or (p_due_transition ->> 'calculationFieldId')::uuid =
        '00000000-0000-0000-0000-000000000000'::uuid
      or not (p_due_transition ->> 'transitionAt') ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      or not pg_catalog.pg_input_is_valid(
        p_due_transition ->> 'transitionAt', 'timestamp with time zone'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    transition_field_id := (p_due_transition ->> 'calculationFieldId')::uuid;
    transition_at_value := (p_due_transition ->> 'transitionAt')::timestamptz;
  end if;

  result_value := vortex_record.save_base_record_with_relationship_totals(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id, p_parent_mutations
  );
  if result_value ->> 'outcome' <> 'saved'
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record deadline metadata requires an Application context';
  end if;
  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id;
  metadata_application_root_id := case storage_row.storage_scope
    when 'application_contained' then (context_value ->> 'applicationRootId')::uuid
    else null
  end;

  saved_record_id := (result_value ->> 'recordId')::uuid;
  saved_concurrency_number := (result_value ->> 'concurrencyNumber')::bigint;
  if p_due_transition is null then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = (context_value ->> 'organizationId')::uuid
      and metadata.storage_contract_id = storage_row.storage_contract_id
      and metadata.record_id = saved_record_id
      and metadata.application_root_id is not distinct from metadata_application_root_id;
  else
    insert into vortex_record.record_deadline_due_metadata (
      organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
      application_root_id, record_concurrency_number,
      deadline_calculation_field_id, transition_at
    ) values (
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      storage_row.storage_scope,
      saved_record_id,
      p_record_type_id,
      metadata_application_root_id,
      saved_concurrency_number,
      transition_field_id,
      transition_at_value
    ) on conflict (
      organization_id, storage_contract_id, record_id, application_root_id
    )
    do update set
      storage_scope = excluded.storage_scope,
      record_type_id = excluded.record_type_id,
      record_concurrency_number = excluded.record_concurrency_number,
      deadline_calculation_field_id = excluded.deadline_calculation_field_id,
      transition_at = excluded.transition_at,
      changed_at = pg_catalog.statement_timestamp();
  end if;

  perform vortex_record.write_parent_deadline_due_metadata_internal(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    p_parent_due_transitions
  );
  return result_value;
end
$function$;

alter function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) owner to vortex_record_adapter;
revoke all on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) to vortex_runtime;

comment on function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb, jsonb
) is
  'Ordinary protected save composed with the engine-derived next deadline transition of the saved record and of every relationship-total parent the save changed.';

-- The named-action writer, unchanged from `20260921100000` except that its
-- final result also carries the ordinal-keyed records it created, which only
-- the due-metadata composer below reads and strips.
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

  if not exists (
    select 1 from vortex_record.named_action_command_receipts receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
  ) then
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
    if preparation_value ->> 'outcome' = 'defer' and exists (
      select 1 from vortex_record.named_action_command_receipts receipt
      where receipt.organization_id = context_organization_id
        and receipt.application_root_id = context_application_id
        and receipt.actor_organization_account_id =
          (context_value ->> 'organizationAccountId')::uuid
        and receipt.command_id = p_command_id
    ) then
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
        for relationship_value in
          select item.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          where item.value ? 'toRecordType'
            and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
        loop
          select item.value into target_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(relationship_value #>> '{toRecordType,recordTypeId}');
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
              pg_catalog.jsonb_build_array(relationship_value || pg_catalog.jsonb_build_object(
                'toRecordTypeId', relationship_value #> '{toRecordType,recordTypeId}'
              )),
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

    -- Step 5: every edge, in one canonical order across all creations. The
    -- ordinary update writer iterates its own edges `order by fieldId`
    -- (`20260920140000:586-589`); matching that inside each source record type
    -- keeps the two paths consistent on the shared advisory key.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.source_record_type_id, entry.from_field_id collate "C",
        entry.target_record_id
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

-- The named-action counterpart of the ordinary composer: the target record's
-- due row (reconfirmed even when the action wrote nothing to it), and those of
-- every created record and every changed parent, all before commit.
create function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
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
  p_inputs jsonb,
  p_due_transition jsonb,
  p_parent_due_transitions jsonb,
  p_creation_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  context_value jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  metadata_application_root_id uuid;
begin
  if not vortex_record.deadline_due_transition_is_valid_internal(p_due_transition)
    or not vortex_record.parent_deadline_due_transitions_are_valid_internal(
      p_parent_mutations, p_parent_due_transitions
    )
    or not vortex_record.creation_deadline_due_transitions_are_valid_internal(
      p_creations, p_creation_due_transitions
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  result_value := vortex_record.save_named_action_effects_with_relationship_totals(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_submitted_values, p_final_values, p_activity_id, p_occurrence_id,
    p_parent_mutations, p_declared_occurrence_ids, p_creations,
    p_creation_occurrence_ids, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_inputs
  );
  if result_value ->> 'outcome' not in ('saved', 'completed')
    or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value - 'createdRecords';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record deadline metadata requires an Application context';
  end if;
  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id;
  metadata_application_root_id := case storage_row.storage_scope
    when 'application_contained' then (context_value ->> 'applicationRootId')::uuid
    else null
  end;

  if p_due_transition is null or pg_catalog.jsonb_typeof(p_due_transition) = 'null' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = (context_value ->> 'organizationId')::uuid
      and metadata.storage_contract_id = storage_row.storage_contract_id
      and metadata.record_id = p_record_id
      and metadata.application_root_id is not distinct from metadata_application_root_id;
  else
    insert into vortex_record.record_deadline_due_metadata (
      organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
      application_root_id, record_concurrency_number,
      deadline_calculation_field_id, transition_at
    ) values (
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      storage_row.storage_scope,
      p_record_id,
      p_record_type_id,
      metadata_application_root_id,
      (result_value ->> 'concurrencyNumber')::bigint,
      (p_due_transition ->> 'calculationFieldId')::uuid,
      (p_due_transition ->> 'transitionAt')::timestamptz
    ) on conflict (
      organization_id, storage_contract_id, record_id, application_root_id
    )
    do update set
      storage_scope = excluded.storage_scope,
      record_type_id = excluded.record_type_id,
      record_concurrency_number = excluded.record_concurrency_number,
      deadline_calculation_field_id = excluded.deadline_calculation_field_id,
      transition_at = excluded.transition_at,
      changed_at = pg_catalog.statement_timestamp();
  end if;

  perform vortex_record.write_created_deadline_due_metadata_internal(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    p_creations,
    coalesce(result_value -> 'createdRecords', '{}'::jsonb),
    p_creation_due_transitions
  );
  perform vortex_record.write_parent_deadline_due_metadata_internal(
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    p_parent_due_transitions
  );
  return result_value - 'createdRecords';
end
$function$;

alter function vortex_record.deadline_due_record_internal(uuid, uuid, uuid, uuid, uuid)
  owner to vortex_record_adapter;
alter function vortex_record.parent_deadline_due_transitions_are_valid_internal(jsonb, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.write_parent_deadline_due_metadata_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.creation_deadline_due_transitions_are_valid_internal(jsonb, jsonb)
  owner to vortex_record_adapter;
alter function vortex_record.write_created_deadline_due_metadata_internal(
  uuid, uuid, jsonb, jsonb, jsonb
) owner to vortex_record_adapter;
alter function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb, jsonb
) owner to vortex_record_adapter;

revoke all on function vortex_record.deadline_due_record_internal(uuid, uuid, uuid, uuid, uuid),
  vortex_record.parent_deadline_due_transitions_are_valid_internal(jsonb, jsonb),
  vortex_record.write_parent_deadline_due_metadata_internal(uuid, uuid, jsonb),
  vortex_record.creation_deadline_due_transitions_are_valid_internal(jsonb, jsonb),
  vortex_record.write_created_deadline_due_metadata_internal(uuid, uuid, jsonb, jsonb, jsonb),
  vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
    uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid,
    bigint, uuid, jsonb, jsonb, jsonb, jsonb
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
    uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid,
    bigint, uuid, jsonb, jsonb, jsonb, jsonb
  )
to vortex_runtime;

-- The composers are now the only runtime entry points, so no protected save
-- or named action can commit without maintaining its due rows.
revoke execute on function
  vortex_record.save_base_record_with_relationship_totals(
    uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb
  ),
  vortex_record.save_named_action_effects_with_relationship_totals(
    uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid,
    bigint, uuid, jsonb
  )
from vortex_runtime;

comment on function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb, jsonb
) is
  'Protected named action composed with the engine-derived next deadline transition of its target record, every record it created and every relationship-total parent it changed.';
comment on function vortex_record.write_parent_deadline_due_metadata_internal(uuid, uuid, jsonb) is
  'Private: writes the due row of each submitted relationship-total parent at the revision the shared parent writer actually reached.';
comment on function vortex_record.write_created_deadline_due_metadata_internal(
  uuid, uuid, jsonb, jsonb, jsonb
) is
  'Private: writes the due row of each record a named action created with a pending deadline.';

reset role;

-- Installation lifecycle. Every activation and detach changes the binding row
-- inside its own lifecycle transaction.
create function vortex_record.maintain_installation_deadline_due_metadata_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  storage_row vortex_record.storage_catalogue%rowtype;
  deadline_field_id uuid;
begin
  -- An inactive Application cannot refresh its records, so its rows are
  -- obsolete. Organisation-shared rows carry no Application and stay.
  if old.state = 'active' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = old.organization_id
      and metadata.application_root_id = old.application_root_id
      and metadata.storage_contract_id = any (old.storage_contract_ids);
  end if;
  if new.state <> 'active' then
    return null;
  end if;

  -- Each bound contract whose current storage definition (a superset of every
  -- installed release's fields) declares a deadline calculation has every
  -- active record in this binding's scope reselected. Records are locked in
  -- canonical order, so each row carries the revision the refresh will claim.
  for storage_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (new.storage_contract_ids)
    order by catalogue.storage_contract_id
  loop
    if storage_row.state <> 'active' or storage_row.physical_schema_token <> 'record_data' then
      raise exception using errcode = '55000',
        message = 'Installed Record storage is unavailable';
    end if;
    deadline_field_id := null;
    select (field.value ->> 'fieldId')::uuid into deadline_field_id
    from pg_catalog.jsonb_array_elements(
      storage_row.record_type_definition -> 'fields'
    ) as field(value)
    where field.value ->> 'type' = 'calculation'
      and field.value #>> '{settings,expression,kind}' = 'deadline_passed'
    order by pg_catalog.lower(field.value ->> 'fieldId')
    limit 1;
    continue when deadline_field_id is null;

    execute pg_catalog.format(
      'with locked as (
         select stored.record_id, stored.application_root_id, stored.concurrency_number
         from record_data.%I as stored
         where stored.organisation_id = $1
           and stored.application_root_id is not distinct from $2
           and stored.lifecycle_state = ''active''
         order by stored.record_id
         for update
       )
       insert into vortex_record.record_deadline_due_metadata as metadata (
         organization_id, storage_contract_id, storage_scope, record_id, record_type_id,
         application_root_id, record_concurrency_number,
         deadline_calculation_field_id, transition_at
       )
       select $1, $3, $4, locked.record_id, $5, locked.application_root_id,
         locked.concurrency_number, $6, pg_catalog.statement_timestamp()
       from locked
       on conflict (organization_id, storage_contract_id, record_id, application_root_id)
       do update set
         record_concurrency_number = excluded.record_concurrency_number,
         transition_at = least(metadata.transition_at, excluded.transition_at),
         changed_at = pg_catalog.statement_timestamp()',
      storage_row.physical_table_token
    ) using new.organization_id,
      case storage_row.storage_scope
        when 'application_contained' then new.application_root_id
        else null::uuid
      end,
      storage_row.storage_contract_id, storage_row.storage_scope,
      storage_row.record_type_id, deadline_field_id;
  end loop;
  return null;
end
$function$;

-- Organisation time zone. Every pending row may now fall at another instant.
create function vortex_record.reselect_organization_deadline_due_metadata_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  update vortex_record.record_deadline_due_metadata as metadata
  set transition_at = pg_catalog.statement_timestamp(),
    changed_at = pg_catalog.statement_timestamp()
  where metadata.organization_id = new.organization_id
    and metadata.transition_at > pg_catalog.statement_timestamp();
  return null;
end
$function$;

alter function vortex_record.maintain_installation_deadline_due_metadata_internal()
  owner to postgres;
alter function vortex_record.reselect_organization_deadline_due_metadata_internal()
  owner to postgres;
revoke all on function vortex_record.maintain_installation_deadline_due_metadata_internal(),
  vortex_record.reselect_organization_deadline_due_metadata_internal()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
-- Only so the binding owner can attach the trigger; a trigger function cannot
-- be called directly.
grant execute on function vortex_record.maintain_installation_deadline_due_metadata_internal()
  to vortex_module_owner;

set local role vortex_module_owner;
create trigger installation_bindings_maintain_deadline_due_metadata
after update of state on vortex_module.installation_bindings
for each row when (old.state is distinct from new.state)
execute function vortex_record.maintain_installation_deadline_due_metadata_internal();
reset role;

create trigger organization_runtime_settings_reselect_deadline_due_metadata
after update of time_zone on vortex_identity.organization_runtime_settings
for each row when (old.time_zone is distinct from new.time_zone)
execute function vortex_record.reselect_organization_deadline_due_metadata_internal();

comment on function vortex_record.maintain_installation_deadline_due_metadata_internal() is
  'Private binding trigger: reselects due rows for the records of a binding that became active and removes an inactive Application''s rows, in the lifecycle transaction.';
comment on function vortex_record.reselect_organization_deadline_due_metadata_internal() is
  'Private settings trigger: makes every pending due row of an organisation due now after its time zone changes, so the refresh authority re-derives it.';

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;

commit;
