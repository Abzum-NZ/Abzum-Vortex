create or replace function vortex_record.read_record_titles(
  p_targets jsonb
)
returns table (record_type_id uuid, record_id uuid, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_count integer;
  record_count integer;
begin
  if p_targets is null or pg_catalog.jsonb_typeof(p_targets) <> 'array' then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  target_count := pg_catalog.jsonb_array_length(p_targets);
  if target_count > 20 then
    raise exception using errcode = '22023', message = 'Too many title target types';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    where pg_catalog.jsonb_typeof(item.value) <> 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'recordTypeId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'titleFieldId') <> 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'recordIds') <> 'array'
      or item.value ->> 'recordTypeId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or item.value ->> 'titleFieldId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'recordIds') as id(value)
    where pg_catalog.jsonb_typeof(id.value) <> 'string'
      or id.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception using errcode = '22023', message = 'Title targets are invalid';
  end if;
  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(item.value -> 'recordIds')), 0)
  into record_count
  from pg_catalog.jsonb_array_elements(p_targets) as item(value);
  if record_count > 200 then
    raise exception using errcode = '22023', message = 'Too many title records';
  end if;
  return query select * from vortex_record.read_record_titles_internal(p_targets);
end
$function$;

alter function vortex_record.read_record_titles(jsonb) owner to vortex_owner;

revoke all on function vortex_record.read_record_titles(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_record.read_record_titles(jsonb) to vortex_request;

comment on function vortex_record.read_record_titles(jsonb) is
  'Protected batch of record titles for many target record types ([{recordTypeId, titleFieldId, recordIds}], at most 20 types and 200 records); the restricted adapter applies the exact-record access decision to every requested id, resolving the installation access plan once for the call.';
