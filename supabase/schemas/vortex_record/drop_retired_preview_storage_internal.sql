create or replace function vortex_record.drop_retired_preview_storage_internal(
  p_storage_contract_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  storage_row record;
begin
  if not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview storage identity is invalid';
  end if;
  -- Background maintenance only: waiting for a lock would hold this transaction behind a reader
  -- of the retired table, so a held lock fails fast (55P03) and the next run retries.
  perform pg_catalog.set_config('lock_timeout', '200ms', true);

  -- Retired: its binding outlived its deleted preview, so no request reaches this storage any
  -- more, and the binding is deleted only here, with the storage it names. Another run
  -- dropping the same storage holds these rows; this one leaves it to that run.
  select binding.storage_contract_id, catalogue.physical_table_token into storage_row
  from vortex_record.preview_storage_bindings as binding
  join vortex_record.storage_catalogue as catalogue
    on catalogue.storage_contract_id = binding.storage_contract_id
  where binding.storage_contract_id = p_storage_contract_id
    and not exists (
      select 1 from vortex_definition.preview_installations as preview
      where preview.preview_installation_id = binding.preview_installation_id
    )
  for update of binding, catalogue skip locked;
  if not found then
    return false;
  end if;

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
    delete from vortex_record.index_catalogue as index_row
    where index_row.storage_contract_id = storage_row.storage_contract_id;

    delete from vortex_record.preview_storage_bindings as binding
    where binding.storage_contract_id = storage_row.storage_contract_id;

    execute pg_catalog.format('drop table if exists record_data.%I', storage_row.physical_table_token);
    delete from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = storage_row.storage_contract_id;
    delete from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_row.storage_contract_id;
  return true;
end
$function$;

alter function vortex_record.drop_retired_preview_storage_internal(uuid) owner to vortex_owner;

revoke all on function vortex_record.drop_retired_preview_storage_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.drop_retired_preview_storage_internal(uuid)
  to vortex_runtime;
comment on function vortex_record.drop_retired_preview_storage_internal(uuid) is
  'Drops one retired preview storage identity (its preview is gone), including its preview records and record metadata, in its own short background transaction: a held lock fails fast and the next run retries. Preview storage references no platform table, so the drop locks only its own table.';
