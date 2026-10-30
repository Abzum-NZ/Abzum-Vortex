create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_action_kind text,
  p_targets jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- The access plan is resolved here, once for this call, and the one facts
  -- body consumes it for every target of the call.
  return vortex_record.load_record_access_facts_with_plan_internal(
    p_action_kind, p_targets, p_installation,
    vortex_record.resolve_installation_access_plan_internal(p_installation)
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

alter function vortex_record.load_record_access_facts_from_installation_internal(text,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  text, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_record.load_record_access_facts_from_installation_internal(text,jsonb,jsonb) to vortex_owner;
