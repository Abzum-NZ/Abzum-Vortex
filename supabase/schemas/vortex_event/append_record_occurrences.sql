create or replace function vortex_event.append_record_occurrences(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_event.append_record_occurrences_for_resolved_installation_internal(
    p_storage_contract_id, p_record_id, p_occurrences, null::jsonb
  );
end
$function$;

alter function vortex_event.append_record_occurrences(uuid, uuid, jsonb) owner to vortex_event_owner;

revoke all on function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

grant execute on function vortex_event.append_record_occurrences(uuid, uuid, jsonb)
  to vortex_record_adapter;

comment on function vortex_event.append_record_occurrences(uuid, uuid, jsonb) is
  'Appends an exact validated record occurrence batch and minimal logged queue messages in the caller transaction.';
