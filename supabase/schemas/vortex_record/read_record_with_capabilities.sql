create or replace function vortex_record.read_record_with_capabilities(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
begin
  -- One exact read decision for one record serves both answers: the
  -- projection vortex_record.read_record returns and the capabilities
  -- vortex_record.read_record_capabilities returns, which reuse the read facts
  -- and field bounds of that decision exactly as read_record_capabilities does.
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
      ) end
  );
end
$function$;

alter function vortex_record.read_record_with_capabilities(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_with_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_with_capabilities(uuid, uuid) is
  'Fixed record read adapter for one record: returns, from one read decision under the caller''s current authority, the readable field projection vortex_record.read_record returns (record) and the permitted actions and changeable fields vortex_record.read_record_capabilities returns (capabilities, null unless the record is readable).';
