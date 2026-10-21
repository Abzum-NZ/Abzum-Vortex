create or replace function vortex_record.read_record_type_visible_field_ids(p_record_type_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_record.resolve_record_type_visible_field_ids_internal(
    p_record_type_id,
    vortex_record.resolve_installation_access_plan_internal(
      vortex_definition.read_current_active_installation()
    )
  );
end
$function$;

alter function vortex_record.read_record_type_visible_field_ids(uuid) owner to vortex_owner;
revoke all on function vortex_record.read_record_type_visible_field_ids(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_record_type_visible_field_ids(uuid) to vortex_request;
comment on function vortex_record.read_record_type_visible_field_ids(uuid) is
  'The columns of one record type the validated human context may read now, by access route; field identities only, resolved once before a grid or picker reads its rows.';
