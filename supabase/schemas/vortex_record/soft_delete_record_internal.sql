create or replace function vortex_record.soft_delete_record_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  begin
    perform vortex_record.soft_delete_record_recursive_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, array[]::text[]
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1
    );
  exception
    when serialization_failure or deadlock_detected then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    when no_data_found or too_many_rows or insufficient_privilege or check_violation
      or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end;
end
$function$;

alter function vortex_record.soft_delete_record_internal(uuid,uuid,bigint)
  owner to vortex_record_adapter;

revoke all on function vortex_record.soft_delete_record_internal(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.soft_delete_record_internal(uuid,uuid,bigint) is
  'Private revision-checked recoverable delete primitive with current Access and declared incoming relationship handling; it sets no recovery policy.';
