set local role vortex_owner;

create index preview_installations_global_expiry_idx
  on vortex_definition.preview_installations (expires_at, preview_installation_id);

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
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
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

alter function vortex_record.drop_preview_installation_storage(uuid) owner to vortex_owner;

revoke all on function vortex_record.drop_preview_installation_storage(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.drop_preview_installation_storage(uuid)
  to vortex_owner;
comment on function vortex_record.drop_preview_installation_storage(uuid) is
  'Drops only the isolated storage identities marked for one preview installation, including its preview records and record metadata.';

create or replace function vortex_definition.expire_abandoned_preview_installations_internal(
  p_limit integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_row record;
  expired_count integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Preview expiry batch size is invalid';
  end if;

  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.expires_at <= pg_catalog.statement_timestamp()
    order by preview.expires_at, preview.preview_installation_id
    limit p_limit
    -- Overlapping runs (a recovered schedule and the nightly one) never purge the same preview.
    for update of preview skip locked
    for update skip locked
  loop
    perform vortex_record.drop_preview_installation_storage(
      preview_row.preview_installation_id
    );
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
    expired_count := expired_count + 1;
  end loop;

  return expired_count;
end
$function$;

alter function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  owner to vortex_owner;

revoke all on function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_definition.expire_abandoned_preview_installations_internal(integer)
  to vortex_runtime;
comment on function vortex_definition.expire_abandoned_preview_installations_internal(integer) is
  'Purges a bounded batch of expired preview installations across organisations, including their isolated Record storage, for scheduled runtime maintenance only.';

reset role;
