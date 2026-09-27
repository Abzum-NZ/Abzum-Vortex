create or replace function vortex_record.drop_preview_installation_storage(
  p_preview_installation_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  storage_row record;
  removed_count integer := 0;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview storage identity is invalid';
  end if;

  for storage_row in
    select binding.storage_contract_id, catalogue.physical_table_token
    from vortex_record.preview_storage_bindings as binding
    join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = binding.storage_contract_id
    where binding.preview_installation_id = p_preview_installation_id
    order by binding.storage_contract_id
    for update of binding, catalogue
  loop
    if storage_row.physical_table_token <> (
        'rt_' || pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '')
      )
      or not exists (
        select 1 from vortex_record.storage_catalogue as catalogue
        where catalogue.storage_contract_id = storage_row.storage_contract_id
          and catalogue.physical_schema_token = 'record_data'
          and catalogue.state = 'active'
      ) then
      raise exception using errcode = '55000', message = 'Preview storage lineage is incompatible';
    end if;

    delete from vortex_record.relationship_edges as edge
    where edge.from_storage_contract_id = storage_row.storage_contract_id
      or edge.to_storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_reference_counters as counter
    where counter.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.record_data_versions as version
    where version.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;

    delete from vortex_record.preview_storage_bindings as binding
    where binding.preview_installation_id = p_preview_installation_id
      and binding.storage_contract_id = storage_row.storage_contract_id;

    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
    removed_count := removed_count + 1;
  end loop;

  return removed_count;
end
$function$;

revoke all on function vortex_record.drop_preview_installation_storage(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_record.drop_preview_installation_storage(uuid)
  to vortex_module_owner;
comment on function vortex_record.drop_preview_installation_storage(uuid) is
  'Drops only the isolated storage identities marked for one preview installation, including its preview records and record metadata.';
