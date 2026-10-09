create or replace function vortex_record.lock_record_file_lifecycle_inventory_internal(
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  relation_row record;
  storage_row vortex_record.storage_catalogue%rowtype;
  relation_oid oid;
  owner_role_oid oid := 'vortex_record_owner'::regrole::oid;
  contract_id_value uuid;
  token_value text;
  relation_count integer := 0;
  attachment_mappings jsonb := '[]'::jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Record File inventory command is invalid';
  end if;
  authority := vortex_record.read_record_owned_file_lifecycle_authority_internal(
    p_command_id
  );
  if authority ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_array_length(authority -> 'effects') = 0 then
    raise exception using errcode = '42501',
      message = 'Record File inventory authority is unavailable';
  end if;

  -- Freeze catalogue membership before enumerating tables, then take SHARE
  -- locks in one bytewise order so no concurrent Record writer can add or
  -- redirect an attachment reference during the organization-wide scan.
  lock table vortex_record.storage_catalogue,
    vortex_record.field_storage_mappings in share mode;

  if exists (
    select 1
    from vortex_record.storage_catalogue as catalogue
    where catalogue.state = 'active'
      and (catalogue.physical_schema_token is null
        or catalogue.physical_schema_token not in ('record_data', 'system_projection'))
  ) then
    raise exception using errcode = '55000',
      message = 'Record File inventory has an unsupported storage scope';
  end if;

  for storage_row in
    select stored.*
    from vortex_record.storage_catalogue as stored
    where stored.physical_schema_token in ('record_data', 'system_projection')
    order by stored.physical_table_token collate "C", stored.storage_contract_id
  loop
    if storage_row.physical_table_token !~ '^rt_[0-9a-f]{32}$'
      or storage_row.physical_table_token <> 'rt_' ||
        pg_catalog.replace(pg_catalog.lower(storage_row.storage_contract_id::text), '-', '') then
      raise exception using errcode = '55000',
        message = 'Record File inventory catalogue is incomplete';
    end if;
    relation_oid := pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', 'record_data', storage_row.physical_table_token
    ))::oid;
    if relation_oid is null
      or not exists (
        select 1 from pg_catalog.pg_class as relation
        where relation.oid = relation_oid
          and relation.relkind = 'r'
          and relation.relpersistence = 'p'
          and not relation.relispartition
          and relation.relowner = owner_role_oid
          and relation.relrowsecurity
          and relation.relforcerowsecurity
      ) then
      raise exception using errcode = '55000',
        message = 'Record File inventory storage is unavailable';
    end if;
  end loop;

  -- Every physical rt_/cp_ relation must have one exact contract lineage.
  -- Missing or unexpected inventory fails closed instead of becoming an empty
  -- owner set. All rows are scanned only by the current-organisation role.
  for relation_row in
    select relation.oid, relation.relname
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'record_data'
      and relation.relkind = 'r'
      and relation.relpersistence = 'p'
      and not relation.relispartition
      and (relation.relname ~ '^rt_[0-9a-f]{32}$'
        or relation.relname ~ '^cp_[0-9a-f]{32}$')
    order by relation.relname collate "C", relation.oid
  loop
    if not exists (
      select 1 from pg_catalog.pg_class as relation
      where relation.oid = relation_row.oid
        and relation.relowner = owner_role_oid
        and relation.relrowsecurity
        and relation.relforcerowsecurity
    ) then
      raise exception using errcode = '55000',
        message = 'Record File inventory relation is incompatible';
    end if;
    token_value := pg_catalog.substr(relation_row.relname, 4);
    contract_id_value := (
      pg_catalog.substr(token_value, 1, 8) || '-' ||
      pg_catalog.substr(token_value, 9, 4) || '-' ||
      pg_catalog.substr(token_value, 13, 4) || '-' ||
      pg_catalog.substr(token_value, 17, 4) || '-' ||
      pg_catalog.substr(token_value, 21, 12)
    )::uuid;
    if pg_catalog.starts_with(relation_row.relname, 'rt_') then
      if not exists (
        select 1 from vortex_record.storage_catalogue as catalogue
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = relation_row.relname
          and catalogue.physical_schema_token in ('record_data', 'system_projection')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory Record lineage is unavailable';
      end if;
    else
      if not exists (
        select 1
        from vortex_record.storage_catalogue as catalogue
        join vortex_record.field_storage_mappings as mapping
          on mapping.storage_contract_id = catalogue.storage_contract_id
        where catalogue.storage_contract_id = contract_id_value
          and catalogue.physical_table_token = 'rt_' || token_value
          and mapping.introduced_by_module_root_id <> catalogue.module_root_id
          and mapping.state in ('active', 'retired')
      ) then
        raise exception using errcode = '55000',
          message = 'Record File inventory companion lineage is unavailable';
      end if;
    end if;
    execute pg_catalog.format(
      'lock table record_data.%I in share mode', relation_row.relname
    );
    relation_count := relation_count + 1;
  end loop;

  if relation_count = 0 then
    raise exception using errcode = '55000',
      message = 'Record File inventory is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'storage_contract_id', catalogue.storage_contract_id,
      'module_root_id', catalogue.module_root_id,
      'record_type_id', catalogue.record_type_id,
      'storage_scope', catalogue.storage_scope,
      'base_table_token', catalogue.physical_table_token,
      'table_token', case
        when mapping.introduced_by_module_root_id = catalogue.module_root_id
          then catalogue.physical_table_token
        else 'cp_' || pg_catalog.replace(
          pg_catalog.lower(catalogue.storage_contract_id::text), '-', ''
        ) end,
      'field_id', mapping.field_id,
      'column_token', mapping.physical_column_token,
      'database_value_type', mapping.database_value_type,
      'introduced_by_module_root_id', mapping.introduced_by_module_root_id
    ) order by catalogue.storage_contract_id, mapping.field_id
  ), '[]'::jsonb)
  into attachment_mappings
  from vortex_record.storage_catalogue as catalogue
  join vortex_record.field_storage_mappings as mapping
    on mapping.storage_contract_id = catalogue.storage_contract_id
  where mapping.state in ('active', 'retired')
    and mapping.field_definition ->> 'type' = 'attachment'
    and catalogue.physical_schema_token in ('record_data', 'system_projection');

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(attachment_mappings) as item(value)
    where not exists (
      select 1
      from pg_catalog.pg_class as relation
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = relation.relnamespace
      join pg_catalog.pg_attribute as attribute
        on attribute.attrelid = relation.oid
      where namespace.nspname = 'record_data'
        and relation.relname = item.value ->> 'table_token'
        and relation.relowner = owner_role_oid
        and relation.relkind = 'r'
        and relation.relpersistence = 'p'
        and relation.relrowsecurity
        and relation.relforcerowsecurity
        and attribute.attname = item.value ->> 'column_token'
        and attribute.attnum > 0
        and not attribute.attisdropped
        and attribute.atttypid = 'jsonb'::regtype
    )
  ) then
    raise exception using errcode = '55000',
      message = 'Record File attachment catalogue is incomplete';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'locked', 'relationCount', relation_count,
    'attachmentMappings', attachment_mappings
  );
end
$function$;

alter function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  owner to vortex_record_owner;

revoke all on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_file_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid)
  to vortex_record_inventory, vortex_record_owner;
comment on function vortex_record.lock_record_file_lifecycle_inventory_internal(uuid) is
  'Privately locks the complete mapped Record and companion-table inventory for the current pending HUMAN lifecycle deletion before cross-Application attachment membership is derived.';
