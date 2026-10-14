create or replace function vortex_record.read_record(
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
  projection jsonb;
begin
  select row_read.projection into projection
  from vortex_record.read_record_projection_internal(p_record_type_id, p_record_id) as row_read;
  return projection;
end
$function$;

alter function vortex_record.read_record(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_owner;

comment on function vortex_record.read_record(uuid, uuid) is
  'Fixed record read adapter: returns the readable field projection of one live record under the caller''s current authority or one preview record for its validated preview owner, or an identical refusal for a missing, foreign or unreachable record.';
