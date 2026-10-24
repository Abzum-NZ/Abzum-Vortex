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
  read_row record;
begin
  -- The projection and capabilities reuse one exact read decision and its field bounds.
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

alter function vortex_record.read_record(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;

grant execute on function vortex_record.read_record(uuid, uuid) to vortex_owner;

comment on function vortex_record.read_record(uuid, uuid) is
  'Exact record read: returns the readable record projection and its capabilities from one current read decision; missing, foreign and unreadable records share the same refusal and null capabilities.';
