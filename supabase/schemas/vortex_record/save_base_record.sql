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
  mutation_kind text;
  mutations jsonb;
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

  -- The ordinary save is the record-change operation with one mutation: a
  -- create subject or one field set. The operation owns the receipt, the
  -- canonical lock order, the access decision, the Activity and the Event.
  mutation_kind := case when p_operation = 'create'
    then 'create_subject' else 'set_fields' end;
  mutations := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'kind', mutation_kind,
    'values', p_final_values
  ));

  return vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id,
    mutations, p_activity_id, p_occurrence_id
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
  'The ordinary human Record save, expressed as one create_subject or set_fields record-change mutation through the one protected apply_record_changes operation.';
