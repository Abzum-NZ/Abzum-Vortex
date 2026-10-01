create or replace function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_event.append_record_occurrences_with_native_proof_internal(
    p_storage_contract_id,
    p_record_id,
    p_occurrences,
    p_installation,
    null::jsonb
  );
end
$function$;

alter function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) owner to postgres;
revoke all on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) to vortex_event_owner;
comment on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) is
  'Appends an exact validated record occurrence batch through the shared Event implementation; this compatibility wrapper always supplies NULL native proof, so installation JSON cannot enter the system-projection path.';