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
  if p_requested_field_ids is not null then
    if pg_catalog.jsonb_typeof(p_requested_field_ids) is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(p_requested_field_ids) as item(value)
        where pg_catalog.jsonb_typeof(item.value) <> 'string'
          or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
      ) then
      raise exception using errcode = '22023', message = 'Requested record fields are invalid';
    end if;
    select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.lower(item.value)), '[]'::jsonb)
    into p_requested_field_ids
    from pg_catalog.jsonb_array_elements_text(p_requested_field_ids) as item(value);
  end if;
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
