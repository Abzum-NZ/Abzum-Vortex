-- #559: complete deadline due-metadata maintenance for named-action writes and
-- for relationship-total parent writes reached from either terminal writer.
--
-- The ordinary-save composer (`20260923030000`) already keeps
-- `vortex_record.record_deadline_due_metadata` current for the root record of
-- an ordinary save, but never for the relationship-total parents that same
-- save can mutate, and the named-action terminal writer
-- (`save_named_action_effects_with_relationship_totals`) never touched the
-- table at all. Both gaps are closed here by pure composition: every existing
-- shared writer (`save_base_record_with_relationship_totals`,
-- `save_named_action_effects_with_relationship_totals`,
-- `apply_relationship_total_parent_internal`) stays untouched, and each
-- composer here reuses `vortex_record.write_deadline_closure_due_metadata_internal`
-- (`20260923155800`) for the bounded set of parents its own caller already
-- discovered, exactly as the #558 closure does for the parents it reaches.
--
-- A relationship-total parent only advances its revision when
-- `apply_relationship_total_parent_internal` sees at least one field actually
-- change; the caller computes that same reduction in TypeScript
-- (`deriveParentDeadlineDueMutations`) and omits an unchanged parent from
-- `p_parent_due_metadata` entirely, so this migration never has to guess a
-- parent's post-write revision.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

set local role vortex_record_adapter;

drop function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, uuid, jsonb, jsonb
);

-- Unchanged root-record composition and due-metadata upsert/cancellation from
-- `20260923030000`, with one addition: `p_parent_due_metadata` carries the
-- bounded, already-reduced set of relationship-total parents this same save
-- actually mutated, each with the caller-derived due transition for its own
-- next pending deadline.
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
  p_parent_due_metadata jsonb
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
  parent_entry jsonb;
begin
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

  if pg_catalog.jsonb_typeof(p_parent_due_metadata) = 'array' then
    for parent_entry in
      select item.value from pg_catalog.jsonb_array_elements(p_parent_due_metadata) item(value)
      order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
    loop
      if not (parent_entry ?& array['recordTypeId', 'recordId', 'recordType', 'concurrencyNumber'])
        or not vortex_record.deadline_due_transition_is_valid_internal(
          parent_entry -> 'dueTransition'
        ) then
        raise exception using errcode = '22023',
          message = 'Parent deadline due metadata entry is invalid';
      end if;
      perform vortex_record.write_deadline_closure_due_metadata_internal(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        pg_catalog.jsonb_build_object(
          'storageContractId', parent_entry #> '{recordType,storageContractId}',
          'recordTypeId', parent_entry -> 'recordTypeId',
          'recordId', parent_entry -> 'recordId',
          'recordType', parent_entry -> 'recordType'
        ),
        (parent_entry ->> 'concurrencyNumber')::bigint,
        parent_entry -> 'dueTransition'
      );
    end loop;
  end if;

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
  'Ordinary protected save composed with private upsert/cancellation of the final engine-derived earliest deadline transition for the root record and every relationship-total parent this same save actually changed.';

-- The named-action terminal writer never maintained due metadata at all. This
-- composer keeps `save_named_action_effects_with_relationship_totals`
-- unchanged and applies the same root/parent due-metadata pattern as the
-- ordinary-save composer above; the named action's target record and type are
-- already fixed command inputs, so no read-back through the inner result is
-- needed to locate the root row.
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
  p_parent_due_metadata jsonb
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
  parent_entry jsonb;
begin
  if not vortex_record.deadline_due_transition_is_valid_internal(p_due_transition) then
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

  if p_due_transition is null then
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

  if pg_catalog.jsonb_typeof(p_parent_due_metadata) = 'array' then
    for parent_entry in
      select item.value from pg_catalog.jsonb_array_elements(p_parent_due_metadata) item(value)
      order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
    loop
      if not (parent_entry ?& array['recordTypeId', 'recordId', 'recordType', 'concurrencyNumber'])
        or not vortex_record.deadline_due_transition_is_valid_internal(
          parent_entry -> 'dueTransition'
        ) then
        raise exception using errcode = '22023',
          message = 'Parent deadline due metadata entry is invalid';
      end if;
      perform vortex_record.write_deadline_closure_due_metadata_internal(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        pg_catalog.jsonb_build_object(
          'storageContractId', parent_entry #> '{recordType,storageContractId}',
          'recordTypeId', parent_entry -> 'recordTypeId',
          'recordId', parent_entry -> 'recordId',
          'recordType', parent_entry -> 'recordType'
        ),
        (parent_entry ->> 'concurrencyNumber')::bigint,
        parent_entry -> 'dueTransition'
      );
    end loop;
  end if;

  return result_value;
end
$function$;

alter function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb
) owner to vortex_record_adapter;
revoke all on function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb
) to vortex_runtime;

comment on function vortex_record.save_named_action_effects_with_relationship_totals_and_deadline_due_metadata(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, uuid, bigint,
  uuid, jsonb, jsonb, jsonb
) is
  'Protected named action composed with private upsert/cancellation of the final engine-derived earliest deadline transition for the target record and every relationship-total parent this same command actually changed.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
