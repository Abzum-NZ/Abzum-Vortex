create or replace function vortex_event.append_detached_offboarding_reassignment_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_record_type_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation jsonb;
begin
  if p_storage_contract_id is null
    or p_record_id is null
    or p_record_type_id is null
    or p_occurrence_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Detached reassignment Event input is invalid';
  end if;
  installation := vortex_module.read_current_detached_installation_for_transfer_internal();
  return vortex_event.append_record_occurrences_for_resolved_installation_internal(
    p_storage_contract_id,
    p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
    )),
    installation
  );
end
$function$;

alter function vortex_event.append_detached_offboarding_reassignment_internal(uuid, uuid, uuid, uuid) owner to vortex_event_owner;

revoke all on function vortex_event.append_detached_offboarding_reassignment_internal(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_event.append_detached_offboarding_reassignment_internal(uuid, uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_event.append_detached_offboarding_reassignment_internal(uuid, uuid, uuid, uuid) is
  'Appends exactly one content-free record reassignment Event occurrence for a detached installation during protected offboarding.';
