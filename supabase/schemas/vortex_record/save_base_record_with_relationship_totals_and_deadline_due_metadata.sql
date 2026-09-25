create or replace function vortex_record.save_base_record_with_relationship_totals_and_deadline_due_metadata(
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
