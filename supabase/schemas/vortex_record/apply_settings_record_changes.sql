create or replace function vortex_record.apply_settings_record_changes(
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
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  return vortex_record.apply_record_changes(
    p_command_id, 'settings', p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, null,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'kind', 'settings', 'values', p_final_values
    )), p_activity_id, p_occurrence_id
  );
end
$function$;

alter function vortex_record.apply_settings_record_changes(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_settings_record_changes(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_settings_record_changes(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) to vortex_runtime;

comment on function vortex_record.apply_settings_record_changes(
  uuid, uuid, uuid, bigint, jsonb, jsonb, uuid, uuid
) is
  'Closed runtime entry for a settings mutation through the one protected apply_record_changes operation.';
