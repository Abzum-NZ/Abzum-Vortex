create or replace function vortex_record.prepare_record_restore_target(p_record_type_id uuid, p_record_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  prepared jsonb;
begin
  perform vortex_access.validated_human_request_context();
  if vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  loaded := (vortex_record.load_record_access_facts_internal('restore', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id))) -> 0);
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  -- A retained record has no ordinary page projection. Reveal only its current
  -- revision, and only after the existing exact closure authority check passes.
  prepared := vortex_record.prepare_record_restore_closure_internal(
    p_record_type_id, p_record_id, (loaded ->> 'concurrencyNumber')::bigint
  );
  if prepared ->> 'outcome' is distinct from 'prepared' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'concurrencyNumber', loaded -> 'concurrencyNumber');
exception when no_data_found or insufficient_privilege or check_violation then
  raise warning 'Restore target unavailable: [%] %', sqlstate, sqlerrm;
  return pg_catalog.jsonb_build_object('outcome', 'unavailable');
end
$function$;
alter function vortex_record.prepare_record_restore_target(uuid,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_target(uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_record_restore_target(uuid,uuid) to vortex_request;
comment on function vortex_record.prepare_record_restore_target(uuid,uuid) is
  'Protected retained-record revision lookup for a restore step: current exact closure authority is required, no stored field values are exposed and no records are written.';
