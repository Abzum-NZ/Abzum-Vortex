-- #50 slice 1: terminal atomic writer for the already-prepared set_field and
-- announce_event named action. The generated set writer retains the reviewed
-- base-save algorithm and replaces only its closed named-action seams.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.append_declared_named_action_occurrences_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_event_descriptors jsonb,
  p_occurrence_ids jsonb,
  p_field_values jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  occurrence_values jsonb := '[]'::jsonb;
  descriptor_value jsonb;
  carried_values jsonb;
  occurrence_id_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_event_descriptors) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_occurrence_ids) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_field_values) is distinct from 'object'
    or pg_catalog.jsonb_array_length(p_event_descriptors) <>
      pg_catalog.jsonb_array_length(p_occurrence_ids)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrence_ids) item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
        or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
        or (item.value #>> '{}')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
    ) then
    raise exception using errcode = '22023',
      message = 'Named action Event occurrence input is invalid';
  end if;
  for descriptor_value, occurrence_id_value in
    select descriptor.value, occurrence.value
    from pg_catalog.jsonb_array_elements(p_event_descriptors)
      with ordinality descriptor(value, ordinal)
    join pg_catalog.jsonb_array_elements(p_occurrence_ids)
      with ordinality occurrence(value, ordinal) using (ordinal)
    order by descriptor.ordinal
  loop
    select coalesce(pg_catalog.jsonb_object_agg(
      pg_catalog.lower(field.value #>> '{}'),
      p_field_values -> pg_catalog.lower(field.value #>> '{}')
    ), '{}'::jsonb)
    into carried_values
    from pg_catalog.jsonb_array_elements(descriptor_value -> 'carriedFieldIds') field(value)
    where p_field_values ? pg_catalog.lower(field.value #>> '{}');
    occurrence_values := occurrence_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'occurrenceId', occurrence_id_value,
        'descriptor', descriptor_value,
        'payload', pg_catalog.jsonb_build_object(
          'kind', 'declared', 'carriedValues', carried_values
        )
      )
    );
  end loop;
  return vortex_event.append_record_occurrences(
    p_storage_contract_id, p_record_id, occurrence_values
  );
end
$function$;

do $migration$
declare
  source_definition text;
  named_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid)'::pg_catalog.regprocedure
  ) into strict source_definition;
  named_definition := pg_catalog.replace(source_definition,
    'CREATE OR REPLACE FUNCTION vortex_record.save_base_record(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid)',
    'CREATE OR REPLACE FUNCTION vortex_record.save_named_action_set_fields_internal(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_inputs jsonb)');
  named_definition := pg_catalog.replace(named_definition,
    'vortex_record.save_command_receipts',
    'vortex_record.named_action_command_receipts');
  named_definition := pg_catalog.replace(named_definition,
    E'    or p_operation not in (''create'', ''update'')',
    E'    or p_operation is distinct from ''update''\n    or p_action_owner_kind not in (''application'', ''module'')\n    or p_action_owner_id is null or p_action_id is null\n    or p_action_release_revision not between 1 and 9007199254740991\n    or pg_catalog.jsonb_typeof(p_inputs) is distinct from ''object''');
  named_definition := pg_catalog.replace(named_definition,
    E'  command_fingerprint_value := vortex_record.base_save_command_fingerprint_internal(\n    p_command_id, p_operation, p_record_type_id, p_record_id,\n    p_expected_concurrency_number, p_submitted_values, p_selected_group_id\n  );',
    E'  command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(\n    p_command_id, p_action_owner_kind, p_action_owner_id,\n    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,\n    p_expected_concurrency_number, p_inputs\n  );');
  named_definition := pg_catalog.replace(named_definition,
    E'    command_id, command_fingerprint, record_type_id, operation, state\n  ) values (\n    organization_id_value, application_root_id_value, actor_id_value,\n    p_command_id, command_fingerprint_value, p_record_type_id, p_operation,\n    ''pending''',
    E'    command_id, command_fingerprint, action_owner_kind, action_owner_id,\n    action_release_revision, action_id, record_type_id, record_id, state\n  ) values (\n    organization_id_value, application_root_id_value, actor_id_value,\n    p_command_id, command_fingerprint_value, p_action_owner_kind, p_action_owner_id,\n    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,\n    ''pending''');
  named_definition := pg_catalog.replace(named_definition,
    E'      or receipt.record_type_id is distinct from p_record_type_id\n      or receipt.operation is distinct from p_operation',
    E'      or receipt.action_owner_kind is distinct from p_action_owner_kind\n      or receipt.action_owner_id is distinct from p_action_owner_id\n      or receipt.action_release_revision is distinct from p_action_release_revision\n      or receipt.action_id is distinct from p_action_id\n      or receipt.record_type_id is distinct from p_record_type_id\n      or receipt.record_id is distinct from p_record_id');
  named_definition := pg_catalog.replace(named_definition,
    'projection := vortex_record.read_record(p_record_type_id, receipt.record_id);',
    E'projection := vortex_record.project_named_action_record_internal(\n      p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n      p_action_id, p_record_type_id, receipt.record_id\n    );');
  named_definition := pg_catalog.replace(named_definition,
    'projection ->> ''outcome'' <> ''allowed''',
    'projection ->> ''outcome'' <> ''completed''');
  named_definition := pg_catalog.replace(named_definition,
    E'  meta := vortex_record.resolve_record_action_context_internal(\n    p_record_type_id, p_operation\n  );',
    E'  meta := vortex_record.resolve_named_action_context_internal(\n    p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n    p_action_id, p_record_type_id\n  );');
  named_definition := pg_catalog.replace(named_definition,
    E'loaded := vortex_record.load_record_access_facts_internal(\n      p_record_type_id, ''update'', p_record_id, p_expected_concurrency_number\n    );',
    E'loaded := vortex_record.load_named_action_facts_internal(\n      p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n      p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number\n    );');
  named_definition := pg_catalog.replace(named_definition,
    'mutation := vortex_record.change_record(',
    'mutation := vortex_record.change_record_by_named_action_internal(');
  named_definition := pg_catalog.replace(named_definition,
    E'        value_final_values, value_submitted_field_ids\n      );',
    E'        value_final_values, value_submitted_field_ids,\n        p_action_owner_kind, p_action_owner_id, p_action_release_revision, p_action_id\n      );');
  named_definition := pg_catalog.replace(named_definition,
    'vortex_record.append_base_save_activity_internal(',
    'vortex_record.append_named_action_activity_internal(');
  named_definition := pg_catalog.replace(named_definition,
    E'p_activity_id, ''update'', organization_id_value,\n        array[]::uuid[], ''refused''',
    E'p_activity_id, p_record_id, array[]::uuid[], ''refused''');
  named_definition := pg_catalog.replace(named_definition,
    E'p_activity_id, ''update'', context_organization_id,\n        array[]::uuid[], ''refused''',
    E'p_activity_id, p_record_id, array[]::uuid[], ''refused''');
  named_definition := pg_catalog.replace(named_definition,
    E'p_activity_id, ''create'', organization_id_value,\n        array[]::uuid[], ''refused''',
    E'p_activity_id, p_record_id, array[]::uuid[], ''refused''');
  named_definition := pg_catalog.replace(named_definition,
    E'p_activity_id, p_operation, saved_record_id,\n    changed_field_ids, ''completed''',
    E'p_activity_id, saved_record_id, changed_field_ids, ''completed''');
  named_definition := pg_catalog.replace(named_definition,
    E'pg_catalog.gen_random_uuid(), ''update'', p_record_id, changed_field_ids, ''completed''',
    E'p_activity_id, p_record_id, changed_field_ids, ''completed''');
  named_definition := pg_catalog.replace(named_definition,
    'projection := vortex_record.read_record(p_record_type_id, saved_record_id);',
    E'projection := vortex_record.project_named_action_record_internal(\n    p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n    p_action_id, p_record_type_id, saved_record_id\n  );');
  named_definition := pg_catalog.replace(named_definition,
    '''Saved Record projection is unavailable''',
    '''Named action Record projection is unavailable''');
  if named_definition = source_definition
    or pg_catalog.strpos(named_definition, 'save_named_action_set_fields_internal') = 0
    or pg_catalog.strpos(named_definition, 'named_action_command_fingerprint_internal') = 0
    or pg_catalog.strpos(named_definition, 'load_named_action_facts_internal') = 0
    or pg_catalog.strpos(named_definition, 'change_record_by_named_action_internal') = 0
    or pg_catalog.strpos(named_definition, 'append_base_save_activity_internal') > 0
    or pg_catalog.strpos(named_definition,
      E'append_named_action_activity_internal(\n        p_activity_id, ''update''') > 0
    or pg_catalog.strpos(named_definition,
      E'append_named_action_activity_internal(\n        p_activity_id, ''create''') > 0
    or pg_catalog.strpos(named_definition,
      'append_named_action_activity_internal(
    pg_catalog.gen_random_uuid(), ''update''') > 0
    or pg_catalog.strpos(named_definition, 'read_record(p_record_type_id') > 0 then
    raise exception using errcode = '55000',
      message = 'Named action set writer clone failed';
  end if;
  execute named_definition;
end
$migration$;

create function vortex_record.save_named_action_set_announce(
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
  inserted_command_id uuid;
  receipt vortex_record.named_action_command_receipts%rowtype;
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
      where effect.value ->> 'kind' not in ('set_field', 'announce_event')
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

  if pg_catalog.jsonb_array_length(set_field_ids) > 0 then
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

  if p_final_values <> '{}'::jsonb then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
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
  insert into vortex_record.named_action_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, command_fingerprint, action_owner_kind, action_owner_id,
    action_release_revision, action_id, record_type_id, record_id, state
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    p_command_id, fingerprint_value, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id, 'pending'
  ) on conflict do nothing returning command_id into inserted_command_id;
  if inserted_command_id is null then
    select stored.* into strict receipt
    from vortex_record.named_action_command_receipts stored
    where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_id = p_command_id for update;
    if receipt.command_fingerprint is distinct from fingerprint_value then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt.state <> 'completed' then
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
  update vortex_record.named_action_command_receipts stored
  set state = 'completed', concurrency_number = p_expected_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = 'Named action receipt is stale';
  end if;
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

-- Preserve the existing relationship-total closure/lock/revision algorithm;
-- substitute only the named preparation and terminal writer calls.
do $migration$
declare
  source_definition text;
  named_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)'::pg_catalog.regprocedure
  ) into strict source_definition;
  named_definition := pg_catalog.replace(source_definition,
    'CREATE OR REPLACE FUNCTION vortex_record.save_base_record_with_relationship_totals(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_parent_mutations jsonb)',
    'CREATE OR REPLACE FUNCTION vortex_record.save_named_action_set_announce_with_relationship_totals(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_final_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_parent_mutations jsonb, p_declared_occurrence_ids jsonb, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid, p_inputs jsonb)');
  named_definition := pg_catalog.replace(named_definition,
    'vortex_record.save_command_receipts',
    'vortex_record.named_action_command_receipts');
  named_definition := pg_catalog.replace(named_definition,
    E'preparation_value := vortex_record.prepare_relationship_total_save(\n      p_command_id, p_operation, p_record_type_id, p_record_id,\n      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,\n      p_activity_id\n    );',
    E'preparation_value := vortex_record.prepare_named_action_relationship_totals(\n      p_command_id, p_operation, p_record_type_id, p_record_id,\n      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,\n      p_activity_id, p_action_owner_kind, p_action_owner_id,\n      p_action_release_revision, p_action_id\n    );');
  named_definition := pg_catalog.replace(named_definition,
    E'result_value := vortex_record.save_base_record(\n    p_command_id, p_operation, p_record_type_id, p_record_id,\n    p_expected_concurrency_number, p_submitted_values, p_final_values,\n    p_selected_group_id, p_activity_id, p_occurrence_id\n  );',
    E'result_value := vortex_record.save_named_action_set_announce(\n    p_command_id, p_record_type_id, p_record_id,\n    p_expected_concurrency_number, p_submitted_values, p_final_values,\n    p_activity_id, p_occurrence_id, p_declared_occurrence_ids,\n    p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n    p_action_id, p_inputs\n  );');
  if named_definition = source_definition
    or pg_catalog.strpos(named_definition,
      'save_named_action_set_announce_with_relationship_totals') = 0
    or pg_catalog.strpos(named_definition,
      'prepare_named_action_relationship_totals') = 0
    or pg_catalog.strpos(named_definition,
      'save_named_action_set_announce(') = 0
    or pg_catalog.strpos(named_definition, 'save_command_receipts') > 0 then
    raise exception using errcode = '55000',
      message = 'Named action total writer clone failed';
  end if;
  execute named_definition;
end
$migration$;

alter function vortex_record.append_declared_named_action_occurrences_internal(uuid,uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
alter function vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;
alter function vortex_record.save_named_action_set_announce(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,text,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;
alter function vortex_record.save_named_action_set_announce_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb,jsonb,text,uuid,bigint,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function
  vortex_record.append_declared_named_action_occurrences_internal(uuid,uuid,jsonb,jsonb,jsonb),
  vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb),
  vortex_record.save_named_action_set_announce(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,text,uuid,bigint,uuid,jsonb),
  vortex_record.save_named_action_set_announce_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.append_declared_named_action_occurrences_internal(uuid,uuid,jsonb,jsonb,jsonb),
  vortex_record.save_named_action_set_fields_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,text,uuid,bigint,uuid,jsonb),
  vortex_record.save_named_action_set_announce(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,text,uuid,bigint,uuid,jsonb)
to vortex_record_adapter;
grant execute on function
  vortex_record.save_named_action_set_announce_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb,jsonb,text,uuid,bigint,uuid,jsonb)
to vortex_runtime;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
