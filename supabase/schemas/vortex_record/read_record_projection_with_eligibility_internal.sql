create or replace function vortex_record.read_record_projection_with_eligibility_internal(
  p_record_type_id uuid, p_record_id uuid, p_page_declaration jsonb, p_page_eligibility jsonb
) returns table (projection jsonb, read_facts jsonb, read_bounds jsonb)
language sql volatile security invoker set search_path = '' as $function$
  select * from vortex_record.read_record_projection_with_validated_types_internal(
    p_record_type_id, p_record_id, p_page_declaration, p_page_eligibility, null::jsonb,
    null::jsonb, null::jsonb, null::jsonb, null::jsonb, null::jsonb
  )
$function$;
alter function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb) owner to vortex_owner;
revoke all on function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb)
  to vortex_record_adapter;
