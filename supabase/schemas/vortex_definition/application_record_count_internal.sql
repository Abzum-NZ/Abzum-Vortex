-- The records an application and the modules it owns hold, counted up to a bound, for the
-- applications read to show what an installed or removed application keeps.
create or replace function vortex_definition.application_record_count_internal(
  p_application_root_id uuid
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  storage_row record;
  total bigint := 0;
  counted bigint;
begin
  for storage_row in
    select catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    join vortex_definition.roots as module on module.root_id = catalogue.module_root_id
    where catalogue.physical_schema_token = 'record_data'
      and (module.root_id = p_application_root_id
        or module.owner_application_root_id = p_application_root_id)
  loop
    if pg_catalog.to_regclass(pg_catalog.format('record_data.%I', storage_row.physical_table_token))
      is null then
      continue;
    end if;
    execute pg_catalog.format(
      'select pg_catalog.count(*) from (select 1 from record_data.%I limit 100000) as bounded',
      storage_row.physical_table_token) into counted;
    total := total + counted;
  end loop;
  return total;
end
$function$;

revoke all on function vortex_definition.application_record_count_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.application_record_count_internal(uuid)
  to vortex_owner;
comment on function vortex_definition.application_record_count_internal(uuid) is
  'Counts, up to 100000 per record table, the records one application and the modules it owns hold; for the applications read, which has already limited its rows to one organisation.';
alter function vortex_definition.application_record_count_internal(uuid) owner to vortex_owner;
