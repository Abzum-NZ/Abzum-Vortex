create or replace function vortex_record.evolve_preview_module_storage(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  record_type jsonb;
  field_value jsonb;
  binding_row vortex_record.preview_storage_bindings%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  release_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  column_token text;
  database_type text;
  index_token text;
  scope_index_columns text;
  evolved_definition jsonb;
  field_ids uuid[];
  storage_identities jsonb := '[]'::jsonb;
begin
  -- The preview follows its draft in place: each record type keeps its storage and its records,
  -- and only what the new release adds or changes is applied to it. A change its records cannot
  -- take raises V3201, and the caller provisions a new preview instead.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(vortex_record.preview_module_record_types_internal(
      p_preview_installation_id, p_module_root_id, p_module_release_revision
    )) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    begin
      release_storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    select binding.* into binding_row
    from vortex_record.preview_storage_bindings as binding
    where binding.preview_installation_id = p_preview_installation_id
      and binding.module_root_id = p_module_root_id
      and binding.record_type_id = record_type_id_value
    for update;
    -- A record type the preview did not have yet starts with empty storage.
    if not found then
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        vortex_record.provision_preview_record_storage_internal(
          p_preview_installation_id, p_module_root_id, p_module_release_revision, record_type
        )
      );
      continue;
    end if;
    select catalogue.* into strict catalogue_row
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = binding_row.storage_contract_id
      and catalogue.physical_schema_token = 'record_data'
      and catalogue.state = 'active'
    for update;
    if catalogue_row.record_type_definition ->> 'storageScope' is distinct from record_type ->> 'storageScope'
      or catalogue_row.record_type_definition ->> 'ownershipMode' is distinct from record_type ->> 'ownershipMode'
      or catalogue_row.record_type_definition ->> 'ownershipRelationshipId' is distinct from record_type ->> 'ownershipRelationshipId'
      or pg_catalog.jsonb_typeof(record_type -> 'fields') is distinct from 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') is distinct from 'array' then
      raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
    end if;
    evolved_definition := pg_catalog.jsonb_set(
      record_type, '{storageContractId}',
      pg_catalog.to_jsonb(binding_row.storage_contract_id::text), true
    );
    -- An unchanged record type keeps its storage exactly as it is: only the release it serves moves.
    if catalogue_row.record_type_definition = evolved_definition then
      if binding_row.module_release_revision <> p_module_release_revision
        or binding_row.release_storage_contract_id is distinct from release_storage_id then
        update vortex_record.storage_catalogue as catalogue
        set first_compatible_release_revision = p_module_release_revision,
            last_compatible_release_revision = p_module_release_revision,
            changed_at = pg_catalog.statement_timestamp()
        where catalogue.storage_contract_id = binding_row.storage_contract_id;
        update vortex_record.field_storage_mappings as mapping
        set introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.state = 'active';
        update vortex_record.preview_storage_bindings as binding
        set module_release_revision = p_module_release_revision,
            release_storage_contract_id = release_storage_id
        where binding.preview_installation_id = p_preview_installation_id
          and binding.storage_contract_id = binding_row.storage_contract_id;
      end if;
      storage_identities := storage_identities || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'moduleRootId', p_module_root_id,
          'moduleReleaseRevision', p_module_release_revision,
          'recordTypeId', record_type_id_value,
          'releaseStorageContractId', release_storage_id,
          'previewStorageContractId', binding_row.storage_contract_id
        )
      );
      continue;
    end if;
    scope_index_columns := case catalogue_row.storage_scope
      when 'organization_shared' then 'organisation_id'
      else 'organisation_id, application_root_id'
    end;
    field_ids := array[]::uuid[];

    for field_value in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      field_ids := field_ids || field_id_value;
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = field_id_value
      for update;
      if found then
        -- Stored values keep their meaning only while the field keeps its database type.
        if mapping_row.database_value_type is distinct from database_type then
          raise exception using errcode = 'V3201', message = 'Preview record storage cannot follow this change';
        end if;
        column_token := mapping_row.physical_column_token;
        -- Preview storage serves exactly the one Module release the preview runs, so each mapping
        -- is that release's.
        update vortex_record.field_storage_mappings as mapping
        set field_definition = field_value,
            introduced_by_module_root_id = p_module_root_id,
            introduced_at_release_revision = p_module_release_revision,
            state = 'active',
            retired_by_module_root_id = null,
            retired_at_release_revision = null
        where mapping.storage_contract_id = binding_row.storage_contract_id
          and mapping.field_id = field_id_value;
      else
        -- Records already in the preview have no value for a new field, so the column takes none;
        -- the save path enforces a required field for every record it writes.
        column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
        execute pg_catalog.format(
          'alter table record_data.%I add column %I %s',
          catalogue_row.physical_table_token, column_token, vortex_record.sql_value_type(database_type)
        );
        insert into vortex_record.field_storage_mappings (
          storage_contract_id, field_id, physical_column_token, database_value_type,
          field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
        ) values (
          binding_row.storage_contract_id, field_id_value, column_token, database_type, field_value,
          p_module_root_id, p_module_release_revision, 'active'
        );
      end if;
      -- Table changes run only where the column or its index actually differs.
      if not (field_value ->> 'required')::boolean and exists (
        select 1
        from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(
            pg_catalog.format('record_data.%I', catalogue_row.physical_table_token))
          and attribute.attname = column_token
          and attribute.attnotnull
      ) then
        execute pg_catalog.format(
          'alter table record_data.%I alter column %I drop not null',
          catalogue_row.physical_table_token, column_token
        );
      end if;
      index_token := 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || field_id_value::text
      );
      if (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is null then
        begin
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            index_token, catalogue_row.physical_table_token, scope_index_columns, column_token
          );
        exception when unique_violation then
          raise exception using errcode = 'V3201', message = 'Preview records repeat a value the draft makes unique';
        end;
      elsif not (field_value ->> 'unique')::boolean
        and pg_catalog.to_regclass(pg_catalog.format('record_data.%I', index_token)) is not null then
        execute pg_catalog.format('drop index record_data.%I', index_token);
      end if;
    end loop;

    -- A field the draft no longer has keeps its column, retired and empty-able, so the records
    -- keep everything else.
    for mapping_row in
      select mapping.*
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.state = 'active'
        and not (mapping.field_id = any(field_ids))
      order by mapping.field_id
      for update
    loop
      execute pg_catalog.format(
        'alter table record_data.%I alter column %I drop not null',
        catalogue_row.physical_table_token, mapping_row.physical_column_token
      );
      execute pg_catalog.format('drop index if exists record_data.%I', 'pux_' || pg_catalog.md5(
        binding_row.storage_contract_id::text || ':' || mapping_row.field_id::text
      ));
      update vortex_record.field_storage_mappings as mapping
      set state = 'retired',
          retired_by_module_root_id = p_module_root_id,
          retired_at_release_revision = p_module_release_revision
      where mapping.storage_contract_id = binding_row.storage_contract_id
        and mapping.field_id = mapping_row.field_id;
    end loop;

    -- A seeded record type whose totals or stored calculations changed has them worked out again
    -- before it is read.
    if (
      select coalesce(pg_catalog.jsonb_agg(field.value order by field.value ->> 'fieldId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(catalogue_row.record_type_definition -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
        or (field.value ->> 'type' = 'calculation'
          and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
    ) is distinct from (
      select coalesce(pg_catalog.jsonb_agg(field.value order by field.value ->> 'fieldId'), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(evolved_definition -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
        or (field.value ->> 'type' = 'calculation'
          and field.value #>> '{settings,evaluation}' is distinct from 'read_time')
    ) then
      update vortex_definition.preview_installation_seeds as seed
      set derived_ready_at = null
      where seed.preview_installation_id = p_preview_installation_id
        and seed.record_type_id = record_type_id_value;
    end if;
    update vortex_record.storage_catalogue as catalogue
    set record_type_definition = evolved_definition,
        content_fingerprint = vortex_record.storage_meaning_fingerprint(evolved_definition),
        -- Preview storage serves exactly the one Module release the preview runs.
        first_compatible_release_revision = p_module_release_revision,
        last_compatible_release_revision = p_module_release_revision,
        changed_at = pg_catalog.statement_timestamp()
    where catalogue.storage_contract_id = binding_row.storage_contract_id;
    update vortex_record.preview_storage_bindings as binding
    set module_release_revision = p_module_release_revision,
        release_storage_contract_id = release_storage_id
    where binding.preview_installation_id = p_preview_installation_id
      and binding.storage_contract_id = binding_row.storage_contract_id;
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', release_storage_id,
        'previewStorageContractId', binding_row.storage_contract_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record storage is unavailable';
end
$function$;

alter function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) owner to vortex_owner;

revoke all on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.evolve_preview_module_storage(uuid, uuid, bigint) is
  'Moves a preview''s isolated Record storage to a newer exact Module release in place, keeping its records: new record types get empty storage, new fields new empty columns, changed fields their new definition and uniqueness, and removed fields are retired; a seeded record type whose totals or stored calculations changed has them worked out again. A change the stored records cannot take (another database type, storage scope or ownership, or a uniqueness they break) raises V3201.';
