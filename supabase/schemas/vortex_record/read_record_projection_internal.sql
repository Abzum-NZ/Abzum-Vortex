create or replace function vortex_record.read_record_projection_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_requested_field_ids jsonb default null
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- One read path: the exact access decision is unchanged; only requested values are projected.
  return query
  select row_read.projection, row_read.read_facts, row_read.read_bounds
  from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, null, null, null, null, null, null, null,
    pg_catalog.jsonb_build_object('requestedFieldIds', p_requested_field_ids)
  ) as row_read;
end
$function$;

alter function vortex_record.read_record_projection_internal(uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_projection_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_projection_internal(uuid, uuid, jsonb) is
  'Private record read: returns the readable field projection of one record together with the read facts and field bounds it was decided over, so the capabilities of the same row reuse them.';

grant execute on function vortex_record.read_record_projection_internal(uuid,uuid,jsonb) to vortex_owner;
