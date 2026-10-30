create or replace function vortex_platform.append_record_occurrences_for_resolved_installation_internal(
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
  if p_storage_contract_id is null or p_record_id is null then
    raise exception using errcode = '22023', message = 'Event append input is invalid';
  end if;
  return vortex_platform.append_record_occurrence_set_internal(
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'storageContractId', p_storage_contract_id, 'recordId', p_record_id, 'occurrences', p_occurrences
    )),
    p_installation
  ) -> 0;
end
$function$;

revoke all on function vortex_platform.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) to vortex_owner;
comment on function vortex_platform.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) is
  'Appends an exact validated record occurrence batch: the occurrence set of one record.';

alter function vortex_platform.append_record_occurrences_for_resolved_installation_internal(uuid, uuid, jsonb, jsonb)
  owner to vortex_owner;
