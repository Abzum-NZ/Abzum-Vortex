create or replace function vortex_record.read_record_titles(
  p_record_type_id uuid,
  p_record_ids uuid[],
  p_title_field_id uuid
)
returns table (record_id uuid, result jsonb)
language sql
volatile
security definer
set search_path = ''
as $function$
  select * from vortex_record.read_record_titles_internal(
    p_record_type_id, p_record_ids, p_title_field_id
  )
$function$;

alter function vortex_record.read_record_titles(uuid,uuid[],uuid) owner to vortex_owner;

revoke all on function vortex_record.read_record_titles(uuid,uuid[],uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_titles(uuid,uuid[],uuid) to vortex_request;

comment on function vortex_record.read_record_titles(uuid,uuid[],uuid) is
  'Protected batch of record titles; the restricted adapter applies the exact-record access decision to every requested id.';
