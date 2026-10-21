create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb,
  p_projection_row jsonb,
  p_requested_field_ids jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- The access plan is resolved here, once for this call, and the one facts
  -- body consumes it. A caller that loads many records resolves the plan itself
  -- and calls load_record_access_facts_with_plan_internal directly.
  return vortex_record.load_record_access_facts_with_plan_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number,
    p_installation, vortex_record.resolve_installation_access_plan_internal(p_installation),
    p_projection_row, p_requested_field_ids
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb,jsonb,jsonb) to vortex_owner;
