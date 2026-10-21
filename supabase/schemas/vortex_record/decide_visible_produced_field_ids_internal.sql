create or replace function vortex_record.decide_visible_produced_field_ids_internal(
  p_plan jsonb, p_record_type_id uuid, p_field_ids jsonb
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select vortex_record.decide_produced_field_ids_internal(
    p_plan, p_record_type_id, p_field_ids, '[]'::jsonb
  )
$function$;

alter function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb)
  to vortex_owner;

comment on function vortex_record.decide_visible_produced_field_ids_internal(jsonb, uuid, jsonb) is
  'Owner-only entry to the one produced-field rule for the column decision: a calculation or total the reader cannot fully read is withheld from the field identities it is given.';
