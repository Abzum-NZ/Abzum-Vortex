create or replace function vortex_record.read_record_projection_internal(
  p_record_type_id uuid,
  p_record_id uuid
)
returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  -- One read path: without page eligibility the variant evaluates this record in full.
  return query
  select row_read.projection, row_read.read_facts, row_read.read_bounds
  from vortex_record.read_record_projection_with_eligibility_internal(
    p_record_type_id, p_record_id, null, null
  ) as row_read;
end
$function$;

alter function vortex_record.read_record_projection_internal(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_projection_internal(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.read_record_projection_internal(uuid, uuid) is
  'Private record read: returns the readable field projection of one record together with the read facts and field bounds it was decided over, so the capabilities of the same row reuse them.';
