create or replace function vortex_record.read_record_capabilities(
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
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  if read_row.projection ->> 'outcome' <> 'allowed' then
    return null;
  end if;
  return vortex_record.read_record_capabilities_internal(
    p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds
  );
end
$function$;

alter function vortex_record.read_record_capabilities(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_capabilities(uuid, uuid) is
  'Fixed record capabilities adapter: for one live record readable under the caller''s current authority or one owner-readable preview record, returns only permitted update, delete and restore actions and changeable fields; preview capabilities are limited to supported updates, and missing, foreign or unreadable records return null.';
