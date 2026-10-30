create or replace function vortex_platform.append_record_occurrence_set(
  p_items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_platform.append_record_occurrence_set_internal(p_items, null::jsonb);
end
$function$;

alter function vortex_platform.append_record_occurrence_set(jsonb) owner to vortex_owner;

revoke all on function vortex_platform.append_record_occurrence_set(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_platform.append_record_occurrence_set(jsonb)
  to vortex_record_adapter;

comment on function vortex_platform.append_record_occurrence_set(jsonb) is
  'Appends exact validated record occurrence batches for several records (each item names its storage contract, record and occurrences) and minimal logged queue messages in the caller transaction.';
