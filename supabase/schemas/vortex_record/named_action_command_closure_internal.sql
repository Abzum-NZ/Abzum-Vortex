create or replace function vortex_record.named_action_command_closure_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_submitted_values jsonb,
  p_creations jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  roots jsonb;
begin
  roots := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordKey', 'root', 'operation', 'update', 'recordTypeId', p_record_type_id,
    'recordId', p_record_id, 'values', p_submitted_values
  )) || coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recordKey', 'create:' || (item.value ->> 'ordinal'), 'operation', 'create',
      'recordTypeId', item.value -> 'recordTypeId', 'recordId', null, 'values', item.value -> 'values'
    ) order by item.ordinality)
    from pg_catalog.jsonb_array_elements(coalesce(p_creations, '[]'::jsonb))
      with ordinality as item(value, ordinality)
  ), '[]'::jsonb);
  return vortex_record.record_change_total_closure_internal(p_catalogue, roots);
end
$function$;
alter function vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
