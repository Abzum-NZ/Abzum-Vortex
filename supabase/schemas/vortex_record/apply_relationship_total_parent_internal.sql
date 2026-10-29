create or replace function vortex_record.apply_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared jsonb;
begin
  prepared := vortex_record.prepare_relationship_total_parent_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number, p_final_values,
    vortex_record.relationship_total_catalogue_internal()
  );
  if prepared is null then return; end if;
  perform vortex_record.apply_record_storage_changes_internal(pg_catalog.jsonb_build_array(prepared -> 'storageChange'));
  perform vortex_record.complete_relationship_total_parent_internal(prepared);
end
$function$;
alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;


alter function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)
  to vortex_record_adapter;

comment on function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb) is
  'Applies protected generated parent totals and calculations with the actual saved revision, Activity and standard Events in the original transaction. Live application-contained writes publish an advisory content-free notice for the actual saved Record; other scopes and previews retain their existing invalidation behavior.';
