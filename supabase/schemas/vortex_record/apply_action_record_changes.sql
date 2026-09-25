create or replace function vortex_record.apply_action_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- The request role reaches the one record-change operation only through a
  -- named action's identity. The ordinary save and its relationship-total
  -- preparation keep their own entry points, so a caller can never skip them by
  -- calling the operation without an action.
  if p_action is null
    or pg_catalog.jsonb_typeof(p_action) is distinct from 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  return vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, null,
    p_mutations, p_activity_id, p_occurrence_id, p_action
  );
end
$function$;

revoke all on function vortex_record.apply_action_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_action_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb
) to vortex_runtime;

comment on function vortex_record.apply_action_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid, jsonb
) is
  'The named-action entry to the one protected apply_record_changes operation: refuses a call without an action identity, then applies the action''s subject, creation, relationship copy, derived-total and declared-Event mutations in one transaction.';
