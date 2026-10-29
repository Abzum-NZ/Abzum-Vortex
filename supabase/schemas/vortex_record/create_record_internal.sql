create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  prepared jsonb;
begin
  prepared := vortex_record.prepare_record_create_internal(
    p_record_type_id, p_final_values, p_submitted_field_ids, p_selected_group_id
  );
  if prepared ->> 'outcome' is distinct from 'prepared' then
    return prepared;
  end if;
  perform vortex_record.apply_record_storage_changes_internal(
    pg_catalog.jsonb_build_array(prepared -> 'storageChange')
  );
  perform vortex_record.apply_relationship_edges_internal(prepared -> 'edgeChanges');
  return vortex_record.complete_record_create_internal(prepared);
exception
  when sqlstate 'P4020' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', sqlerrm);
  when no_data_found or too_many_rows or object_not_in_prerequisite_state then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
end
$function$;
alter function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) is
  'Private single-create composition of the shared set preparation, storage write, edge write and authority finalisation, with rollback on refusal.';
